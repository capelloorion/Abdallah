/**
 * Limits the conversation BFF routes enforce before anything reaches the api. They live here, not
 * in a `route.ts`, because Next route modules may export only HTTP handlers and segment config.
 */

/** `GET ?limit=` — the api's own bounds (`MAX_LIST_LIMIT`). */
export const MIN_LIST_LIMIT = 1;
export const MAX_LIST_LIMIT = 100;

/** `POST` takes `{ "title"?: string }`; anything larger than this is not a title. */
export const MAX_CREATE_BODY_BYTES = 4096;

/** How long a client may take to send that body — a trickling upload must not hold a handler. */
export const BODY_READ_TIMEOUT_MS = 5000;

/** The api's `NVARCHAR(200)`; a JS string's `.length` counts UTF-16 code units, the same unit. */
export const MAX_TITLE_UNITS = 200;

/** The api's `question` limit, in characters (Unicode code points — an emoji counts once). */
export const MAX_QUESTION_CHARS = 4000;

/**
 * A `{ "question": … }` body. 4000 code points can reach 48 KB when a client \u-escapes every
 * astral character, so the cap leaves room for that and nothing more.
 */
export const MAX_ASK_BODY_BYTES = 65_536;

/** What the api calls a conversation until its first answer gives it a title. */
export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

/** A canonical hyphenated UUID — what the api returns as a conversation id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isConversationId(value: string): boolean {
  return UUID.test(value);
}
