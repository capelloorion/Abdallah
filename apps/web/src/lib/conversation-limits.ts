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
