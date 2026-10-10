import { readCappedText } from '../../utils/cappedFetch';

/**
 * Minimal Anthropic + Gemini chat clients for the trip assistant (fork
 * addition). Raw fetch to match the codebase's HTTP style (see
 * llm-parse/clients/anthropic.client.ts). Both endpoints are fixed public
 * hosts, so no SSRF guard is needed; every call has a timeout and a response
 * size cap, and only the text parts of the answer are read.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequest {
  apiKey: string;
  model: string;
  /** Stable instructions — cached by Anthropic between calls. */
  instructions: string;
  /** Trip snapshot; changes as the trip changes. */
  context: string;
  turns: ChatTurn[];
  maxOutputTokens: number;
  timeoutMs: number;
  /**
   * Anthropic `thinking` setting. Current Claude models think by default and
   * that thinking spends the max_tokens budget, which can leave no room for the
   * answer itself; a chat assistant doesn't need it.
   */
  anthropicThinking?: { type: 'disabled' } | { type: 'between_tools' };
}

/** A provider answered with something other than a usable reply. */
export class AssistantProviderError extends Error {
  constructor(
    message: string,
    /** Short, safe-to-show explanation for the chat. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';

/** Merge consecutive same-role turns and make sure the list starts with the user. */
export function normalizeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    if (!t.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text = `${last.text}\n\n${t.text}`;
    else out.push({ role: t.role, text: t.text });
  }
  while (out.length > 0 && out[0]?.role !== 'user') out.shift();
  return out;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AssistantProviderError(
      `${provider} request failed: ${err instanceof Error ? err.message : String(err)}`,
      timedOut ? `${provider} took too long to answer. Please try again.` : `Couldn't reach ${provider}. Check the server's internet connection.`,
    );
  }
  const { text, truncated } = await readCappedText(res, MAX_RESPONSE_BYTES);
  if (!res.ok) {
    throw new AssistantProviderError(`${provider} request failed (${res.status}): ${text.slice(0, 300)}`, explainStatus(provider, res.status));
  }
  if (truncated) throw new AssistantProviderError(`${provider} response exceeded the size cap`, `${provider} sent an answer that was too large.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AssistantProviderError(`${provider} sent non-JSON`, `${provider} sent an unreadable answer. Please try again.`);
  }
}

function explainStatus(provider: string, status: number): string {
  if (status === 401 || status === 403) return `${provider} rejected the API key. Check the key in the container settings.`;
  if (status === 429) return `${provider} usage limit reached. Wait a minute and try again, or switch models.`;
  if (status === 404) return `${provider} doesn't recognize the configured model name.`;
  if (status === 400) return `${provider} couldn't process this request (it may be too long). Try clearing the chat.`;
  if (status >= 500) return `${provider} is having problems right now. Please try again shortly.`;
  return `${provider} returned an error (${status}).`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collect the `text` fields of an array of content parts. */
function joinTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('');
}

export async function callAnthropic(req: ChatRequest): Promise<string> {
  const turns = normalizeTurns(req.turns);
  const body = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    ...(req.anthropicThinking ? { thinking: req.anthropicThinking } : {}),
    system: [
      { type: 'text', text: req.instructions, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: req.context },
    ],
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
  };
  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': req.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body,
    req.timeoutMs,
    'Claude',
  );
  if (!isRecord(data)) throw new AssistantProviderError('Claude sent an unexpected shape', 'Claude sent an unreadable answer.');
  if (data.stop_reason === 'refusal') {
    throw new AssistantProviderError('Claude refused', "Claude couldn't help with that request.");
  }
  // Only text blocks are shown; thinking blocks (if any) are skipped.
  const blocks = Array.isArray(data.content) ? data.content.filter((b) => isRecord(b) && b.type === 'text') : [];
  const text = joinTextParts(blocks).trim();
  if (!text) {
    const outOfRoom = data.stop_reason === 'max_tokens';
    throw new AssistantProviderError(
      `Claude answered with no text (stop_reason=${String(data.stop_reason)})`,
      outOfRoom ? 'Claude ran out of room before answering. Try a shorter or more specific question.' : 'Claude sent an empty answer. Please try again.',
    );
  }
  return text;
}

export async function callGemini(req: ChatRequest): Promise<string> {
  const turns = normalizeTurns(req.turns);
  const body = {
    systemInstruction: { parts: [{ text: `${req.instructions}\n\n${req.context}` }] },
    contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      // Gemini 2.5 Flash thinks by default and that also eats the output budget.
      ...(req.model.startsWith('gemini-2.5-flash') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
    { 'x-goog-api-key': req.apiKey },
    body,
    req.timeoutMs,
    'Gemini',
  );
  if (!isRecord(data)) throw new AssistantProviderError('Gemini sent an unexpected shape', 'Gemini sent an unreadable answer.');
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const first: unknown = candidates[0];
  const content = isRecord(first) ? first.content : undefined;
  const text = joinTextParts(isRecord(content) ? content.parts : undefined).trim();
  if (!text) {
    const blocked = isRecord(data.promptFeedback) && typeof data.promptFeedback.blockReason === 'string';
    throw new AssistantProviderError(
      'Gemini answered with no text',
      blocked ? "Gemini couldn't help with that request." : 'Gemini sent an empty answer. Please try again.',
    );
  }
  return text;
}
