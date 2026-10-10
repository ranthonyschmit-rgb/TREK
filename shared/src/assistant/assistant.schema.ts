import { z } from 'zod';

/**
 * Trip assistant API contract (fork addition) — /api/trips/:tripId/assistant.
 *
 * A shared, per-trip AI chat on the Collab page. The server holds the provider
 * API keys (env), builds the trip context and calls the chosen model; the
 * browser only ever sees the chat rows. Online-only by design: a model call
 * cannot be queued offline and replayed later in any meaningful way.
 */

/** The three choices the model picker offers. */
export const ASSISTANT_MODEL_IDS = ['sonnet', 'haiku', 'gemini'] as const;
export const assistantModelIdSchema = z.enum(ASSISTANT_MODEL_IDS);
export type AssistantModelId = z.infer<typeof assistantModelIdSchema>;

/** Max length of one question typed into the assistant. */
export const ASSISTANT_MAX_INPUT_CHARS = 4000;

export const assistantSendRequestSchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_MAX_INPUT_CHARS),
  model: assistantModelIdSchema,
});
export type AssistantSendRequest = z.infer<typeof assistantSendRequestSchema>;

/**
 * Something the model suggested that a traveler can save into the trip with
 * one click. Parsed leniently from model output on the server, so it is
 * bounded here and never trusted for anything beyond display + a create call
 * that the user confirms by clicking.
 */
export const assistantSuggestionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});
export type AssistantSuggestion = z.infer<typeof assistantSuggestionSchema>;

export const assistantMessageSchema = z.object({
  id: z.number().int(),
  trip_id: z.number().int(),
  user_id: z.number().int().nullable(),
  username: z.string().nullable(),
  role: z.enum(['user', 'assistant']),
  /** Which picker option produced (or was asked for) this message. */
  model: assistantModelIdSchema.nullable(),
  content: z.string(),
  suggestions: z.array(assistantSuggestionSchema),
  is_error: z.boolean(),
  created_at: z.string(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantModelOptionSchema = z.object({
  id: assistantModelIdSchema,
  /** e.g. "Claude Sonnet" */
  name: z.string(),
  /** e.g. "Best (most expensive)" */
  tag: z.string(),
  /** False when the server has no API key for this provider. */
  available: z.boolean(),
});
export type AssistantModelOption = z.infer<typeof assistantModelOptionSchema>;

export const assistantConfigResponseSchema = z.object({
  models: z.array(assistantModelOptionSchema),
});
export type AssistantConfigResponse = z.infer<typeof assistantConfigResponseSchema>;

export const assistantMessagesResponseSchema = z.object({
  messages: z.array(assistantMessageSchema),
});
export type AssistantMessagesResponse = z.infer<typeof assistantMessagesResponseSchema>;

export const assistantSendResponseSchema = z.object({
  question: assistantMessageSchema,
  answer: assistantMessageSchema,
});
export type AssistantSendResponse = z.infer<typeof assistantSendResponseSchema>;

// ── Trip currencies (fork addition) — GET /api/trips/:tripId/currencies ─────

/** The trip converter always converts from this currency. */
export const TRIP_HOME_CURRENCY = 'USD';

export const tripCurrenciesResponseSchema = z.object({
  /** Always TRIP_HOME_CURRENCY. */
  base: z.string(),
  /** ISO-4217 codes for the trip's destination countries, home currency excluded, most places first. */
  currencies: z.array(
    z.object({
      code: z.string(),
      /** ISO-3166 alpha-2 country codes that use this currency on this trip. */
      countries: z.array(z.string()),
    }),
  ),
  /** True when the trip has at least one place whose country could be resolved. */
  hasDestinations: z.boolean(),
});
export type TripCurrenciesResponse = z.infer<typeof tripCurrenciesResponseSchema>;
