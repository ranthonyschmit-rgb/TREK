import { Injectable } from '@nestjs/common';
import {
  TRIP_HOME_CURRENCY,
  type AssistantConfigResponse,
  type AssistantMessage,
  type AssistantModelId,
  type AssistantSuggestion,
  type TripCurrenciesResponse,
} from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RateLimitService } from '../common/rate-limit.service';
import { readEnv } from '../../app-config';
import { resolveCountryCodeSync } from '../atlas/atlas-geo';
import { currencyForCountry } from './country-currency';
import { AssistantProviderError, callAnthropic, callGemini, type ChatTurn } from './assistant-providers';
import { ASSISTANT_INSTRUCTIONS, MAX_CONTEXT_CHARS, clip, extractSuggestions } from './assistant-prompt';
import type { User } from '../../types';

/** Labels shown in the model picker (fork owner's choice). */
const MODEL_LABELS: Record<AssistantModelId, { name: string; tag: string }> = {
  sonnet: { name: 'Claude Sonnet', tag: 'Best (most expensive)' },
  haiku: { name: 'Claude Haiku', tag: 'Budget' },
  gemini: { name: 'Gemini', tag: 'Free' },
};

/** Earlier messages sent along with each question — keeps cost from snowballing. */
const HISTORY_TURNS = 16;
const HISTORY_CHARS_PER_TURN = 2500;
const MAX_OUTPUT_TOKENS = 2048;
/** Hard ceiling for one model call, whatever LLM_TIMEOUT_MS says. */
const MAX_CALL_MS = 120_000;
/** Per-person cap, a cost guard against a stuck key or runaway clicking. */
const QUESTIONS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;
const LIST_LIMIT = 200;

interface MessageRow {
  id: number;
  trip_id: number;
  user_id: number | null;
  username: string | null;
  role: 'user' | 'assistant';
  model: string | null;
  content: string;
  suggestions: string | null;
  is_error: number;
  created_at: string;
}

export type SendResult =
  | { ok: true; question: AssistantMessage; answer: AssistantMessage }
  | { ok: false; error: 'model_unavailable' | 'rate_limited' };

function asModelId(value: string | null): AssistantModelId | null {
  return value === 'sonnet' || value === 'haiku' || value === 'gemini' ? value : null;
}

function parseSuggestions(raw: string | null): AssistantSuggestion[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AssistantSuggestion[]) : [];
  } catch {
    return [];
  }
}

/**
 * Trip assistant + trip currency lookup (fork addition). Owns the
 * trip_assistant_messages SQL, the trip-context snapshot sent to the model,
 * the provider call, and the WebSocket broadcasts.
 */
@Injectable()
export class TripAssistantService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────────
  config(): AssistantConfigResponse {
    const env = readEnv().integrations.assistant;
    const available: Record<AssistantModelId, boolean> = {
      sonnet: !!env.anthropicApiKey,
      haiku: !!env.anthropicApiKey,
      gemini: !!env.geminiApiKey,
    };
    return {
      models: (Object.keys(MODEL_LABELS) as AssistantModelId[]).map((id) => ({
        id,
        name: MODEL_LABELS[id].name,
        tag: MODEL_LABELS[id].tag,
        available: available[id],
      })),
    };
  }

  // ── Messages ────────────────────────────────────────────────────────────
  private toMessage(row: MessageRow): AssistantMessage {
    return {
      id: row.id,
      trip_id: row.trip_id,
      user_id: row.user_id,
      username: row.username,
      role: row.role,
      model: asModelId(row.model),
      content: row.content,
      suggestions: parseSuggestions(row.suggestions),
      is_error: row.is_error === 1,
      created_at: row.created_at,
    };
  }

  private getRow(id: number | bigint): MessageRow | undefined {
    return this.db.get<MessageRow>(
      `SELECT m.*, u.username FROM trip_assistant_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.id = ?`,
      id,
    );
  }

  list(tripId: string | number): AssistantMessage[] {
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM (
         SELECT m.*, u.username FROM trip_assistant_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.trip_id = ?
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`,
      tripId,
      LIST_LIMIT,
    );
    return rows.map((r) => this.toMessage(r));
  }

  private insert(
    tripId: string | number,
    userId: number | null,
    role: 'user' | 'assistant',
    model: AssistantModelId,
    content: string,
    suggestions: AssistantSuggestion[],
    isError: boolean,
  ): AssistantMessage {
    const info = this.db.run(
      `INSERT INTO trip_assistant_messages (trip_id, user_id, role, model, content, suggestions, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      tripId,
      userId,
      role,
      model,
      content,
      suggestions.length > 0 ? JSON.stringify(suggestions) : null,
      isError ? 1 : 0,
    );
    const row = this.getRow(info.lastInsertRowid);
    if (!row) throw new Error('assistant message vanished after insert');
    return this.toMessage(row);
  }

  clear(tripId: string | number, socketId?: string): void {
    this.db.run('DELETE FROM trip_assistant_messages WHERE trip_id = ?', tripId);
    this.realtime.broadcast(tripId, 'assistant:cleared', {}, socketId);
  }

  async send(
    tripId: string | number,
    user: User,
    text: string,
    model: AssistantModelId,
    socketId?: string,
  ): Promise<SendResult> {
    const env = readEnv().integrations;
    const keys = env.assistant;
    const apiKey = model === 'gemini' ? keys.geminiApiKey : keys.anthropicApiKey;
    if (!apiKey) return { ok: false, error: 'model_unavailable' };
    if (!this.rateLimit.check('trip-assistant', String(user.id), QUESTIONS_PER_WINDOW, WINDOW_MS, Date.now())) {
      return { ok: false, error: 'rate_limited' };
    }

    // History is read before the new question is stored, then the question is
    // appended as the final turn.
    const history = this.historyTurns(tripId);
    const question = this.insert(tripId, user.id, 'user', model, text, [], false);
    this.realtime.broadcast(tripId, 'assistant:message:created', { message: question }, socketId);

    const turns: ChatTurn[] = [...history, { role: 'user', text: `[${user.username}]: ${text}` }];
    const request = {
      apiKey,
      model: model === 'sonnet' ? keys.sonnetModel : model === 'haiku' ? keys.haikuModel : keys.geminiModel,
      instructions: ASSISTANT_INSTRUCTIONS,
      context: this.buildContext(tripId),
      turns,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: Math.min(env.llmTimeoutMs, MAX_CALL_MS),
    };

    let answer: AssistantMessage;
    try {
      const reply = model === 'gemini' ? await callGemini(request) : await callAnthropic(request);
      const { text: shown, suggestions } = extractSuggestions(reply);
      answer = this.insert(tripId, null, 'assistant', model, shown, suggestions, false);
    } catch (err) {
      const userMessage = err instanceof AssistantProviderError ? err.userMessage : 'Something went wrong talking to the AI service.';
      console.error('[trip-assistant]', err instanceof Error ? err.message : err);
      answer = this.insert(tripId, null, 'assistant', model, userMessage, [], true);
    }
    // Broadcast to everyone, the asker included: their own tab may have
    // navigated away and back while waiting, and the client dedupes by id.
    this.realtime.broadcast(tripId, 'assistant:message:created', { message: answer }, undefined);
    return { ok: true, question, answer };
  }

  private historyTurns(tripId: string | number): ChatTurn[] {
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM (
         SELECT m.*, u.username FROM trip_assistant_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.trip_id = ? AND m.is_error = 0
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`,
      tripId,
      HISTORY_TURNS,
    );
    return rows.map((r) => ({
      role: r.role,
      text: r.role === 'user' ? `[${r.username ?? 'someone'}]: ${clip(r.content, HISTORY_CHARS_PER_TURN)}` : clip(r.content, HISTORY_CHARS_PER_TURN),
    }));
  }

  // ── Trip context ────────────────────────────────────────────────────────
  /** A plain-text snapshot of the trip for the model, capped in size. */
  buildContext(tripId: string | number): string {
    const trip = this.db.get<{ title: string; description: string | null; start_date: string | null; end_date: string | null; owner: string | null }>(
      `SELECT t.title, t.description, t.start_date, t.end_date, u.username AS owner
       FROM trips t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
      tripId,
    );
    if (!trip) return 'Trip details are unavailable.';

    const members = this.db.all<{ username: string }>(
      `SELECT u.username FROM trip_members tm JOIN users u ON u.id = tm.user_id WHERE tm.trip_id = ? ORDER BY u.username`,
      tripId,
    );
    const travelers = [trip.owner, ...members.map((m) => m.username)].filter((n): n is string => !!n);

    const lines: string[] = [];
    lines.push('## The trip');
    lines.push(`Title: ${clip(trip.title, 200)}`);
    lines.push(`Dates: ${trip.start_date ?? 'not set'} to ${trip.end_date ?? 'not set'}`);
    if (trip.description) lines.push(`Description: ${clip(trip.description, 1000)}`);
    lines.push(`Travelers: ${travelers.join(', ') || 'unknown'}`);
    lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);

    const countries = this.tripCountries(tripId);
    if (countries.length > 0) lines.push(`Destination countries (ISO codes): ${countries.map((c) => c.code).join(', ')}`);

    const places = this.db.all<{ id: number; name: string; address: string | null; description: string | null; notes: string | null; day_number: number | null; day_date: string | null }>(
      `SELECT p.id, p.name, p.address, p.description, p.notes, d.day_number, d.date AS day_date
       FROM places p
       LEFT JOIN day_assignments da ON da.place_id = p.id
       LEFT JOIN days d ON d.id = da.day_id
       WHERE p.trip_id = ?
       ORDER BY COALESCE(d.day_number, 9999), da.order_index, p.id
       LIMIT 150`,
      tripId,
    );
    lines.push('', '## Places already in the trip');
    if (places.length === 0) lines.push('None yet.');
    for (const p of places) {
      const when = p.day_number != null ? `Day ${p.day_number}${p.day_date ? ` (${p.day_date})` : ''}` : 'not scheduled';
      const extra = [p.address && clip(p.address, 120), p.description && clip(p.description, 200), p.notes && `notes: ${clip(p.notes, 200)}`]
        .filter(Boolean)
        .join(' — ');
      lines.push(`- ${clip(p.name, 120)} [${when}]${extra ? ` — ${extra}` : ''}`);
    }

    const reservations = this.db.all<{ title: string; type: string | null; reservation_time: string | null; location: string | null; status: string | null }>(
      `SELECT title, type, reservation_time, location, status FROM reservations WHERE trip_id = ? ORDER BY reservation_time LIMIT 50`,
      tripId,
    );
    if (reservations.length > 0) {
      lines.push('', '## Bookings');
      for (const r of reservations) {
        lines.push(`- ${clip(r.title, 120)} (${r.type ?? 'other'}, ${r.status ?? 'pending'})${r.reservation_time ? ` at ${r.reservation_time}` : ''}${r.location ? ` — ${clip(r.location, 120)}` : ''}`);
      }
    }

    const notes = this.db.all<{ title: string; content: string | null; category: string | null }>(
      `SELECT title, content, category FROM collab_notes WHERE trip_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 30`,
      tripId,
    );
    if (notes.length > 0) {
      lines.push('', '## Shared notes');
      for (const n of notes) lines.push(`- ${clip(n.title, 120)}${n.category ? ` [${clip(n.category, 40)}]` : ''}: ${clip(n.content, 600)}`);
    }

    const links = this.db.all<{ title: string; url: string }>(
      `SELECT title, url FROM collab_links WHERE trip_id = ? ORDER BY pinned DESC, id DESC LIMIT 30`,
      tripId,
    );
    if (links.length > 0) {
      lines.push('', '## Shared links');
      for (const l of links) lines.push(`- ${clip(l.title, 120)}: ${clip(l.url, 300)}`);
    }

    const context = lines.join('\n');
    return context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n…(trimmed)` : context;
  }

  // ── Trip currencies ─────────────────────────────────────────────────────
  /** Countries the trip's places resolve to, most places first. */
  private tripCountries(tripId: string | number): { code: string; places: number }[] {
    const places = this.db.all<{ id: number; lat: number | null; lng: number | null; address: string | null; cached: string | null }>(
      `SELECT p.id, p.lat, p.lng, p.address, pr.country_code AS cached
       FROM places p LEFT JOIN place_regions pr ON pr.place_id = p.id
       WHERE p.trip_id = ?`,
      tripId,
    );
    const counts = new Map<string, number>();
    const seen = new Set<number>();
    for (const p of places) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const code = (p.cached || resolveCountryCodeSync(p))?.toUpperCase();
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, n]) => ({ code, places: n }))
      .sort((a, b) => b.places - a.places || a.code.localeCompare(b.code));
  }

  currencies(tripId: string | number): TripCurrenciesResponse {
    const countries = this.tripCountries(tripId);
    const byCurrency = new Map<string, { countries: string[]; places: number }>();
    for (const c of countries) {
      const currency = currencyForCountry(c.code);
      if (!currency || currency === TRIP_HOME_CURRENCY) continue;
      const entry = byCurrency.get(currency) ?? { countries: [], places: 0 };
      entry.countries.push(c.code);
      entry.places += c.places;
      byCurrency.set(currency, entry);
    }
    return {
      base: TRIP_HOME_CURRENCY,
      currencies: [...byCurrency.entries()]
        .sort((a, b) => b[1].places - a[1].places || a[0].localeCompare(b[0]))
        .map(([code, e]) => ({ code, countries: e.countries })),
      hasDestinations: countries.length > 0,
    };
  }
}
