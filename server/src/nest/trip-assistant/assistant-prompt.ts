import { assistantSuggestionSchema, type AssistantSuggestion } from '@trek/shared';

/**
 * Prompt text and reply post-processing for the trip assistant (fork addition).
 * Pure functions, no I/O.
 */

export const ASSISTANT_INSTRUCTIONS = `You are the trip-planning assistant inside TREK, a collaborative trip planner. A small group of friends shares this chat while they brainstorm and plan one trip together. Several different people may ask questions; each question is prefixed with the asker's name in square brackets.

How to help:
- Brainstorm ideas, suggest places, restaurants, activities and day plans, and help the group make decisions.
- Use the trip details provided (destinations, dates, travelers, places already planned, notes, links). Don't suggest things they already have planned unless asked.
- Be practical and specific. Prefer short paragraphs and bullet lists. Use Markdown.
- Prices, opening hours and event dates change; say when something should be double-checked.
- If the trip has no destination or dates yet, help them decide.

When you recommend specific places someone could add to the trip (restaurants, sights, hotels, activities), end your reply with a fenced code block in exactly this format, listing at most 8 of them:

\`\`\`suggestions
[{"name": "Place name, City", "description": "One short sentence on why it's worth it."}]
\`\`\`

Only include that block when you named concrete places. Never mention the block itself in your reply.`;

/** Max characters of trip context sent with each question. */
export const MAX_CONTEXT_CHARS = 24_000;

const SUGGESTION_BLOCK = /```suggestions\s*\n([\s\S]{0,20000}?)\n?```\s*$/;

/**
 * Split a model reply into the text shown in the chat and the structured
 * suggestions. Lenient: a malformed or missing block just means no buttons.
 */
export function extractSuggestions(reply: string): { text: string; suggestions: AssistantSuggestion[] } {
  const trimmed = reply.trimEnd();
  const match = SUGGESTION_BLOCK.exec(trimmed);
  if (!match) return { text: trimmed, suggestions: [] };
  const text = trimmed.slice(0, match.index).trimEnd();
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? '');
  } catch {
    return { text, suggestions: [] };
  }
  if (!Array.isArray(parsed)) return { text, suggestions: [] };
  const suggestions: AssistantSuggestion[] = [];
  for (const item of parsed.slice(0, 8)) {
    const result = assistantSuggestionSchema.safeParse(item);
    if (result.success) suggestions.push(result.data);
  }
  return { text: text || 'Here are some ideas:', suggestions };
}

/** Keep a long string from blowing up the prompt. */
export function clip(value: string | null | undefined, max: number): string {
  const s = (value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
