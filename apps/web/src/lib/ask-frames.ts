import type { components } from '@/lib/api-types';
import { sseFrame } from '@/lib/sse';

type Citation = components['schemas']['Citation'];

/**
 * What each frame of `POST /v1/conversations/{id}/ask/stream` carries. The stream is not a JSON
 * schema, so OpenAPI cannot generate this: the contract is the operation's description in
 * `docs/reference/openapi.json` (and `apps/api/app/ai/streaming.py`, which builds the frames).
 * The citation shape is the generated one; everything else is written here once, so the mock
 * fixtures cannot drift from it.
 *
 * The browser reads these frames defensively (`chat-client.ts` checks every field and never
 * trusts a type): these types describe what the api SENDS, not what the browser may assume.
 */
export interface AskFrames {
  /** After retrieval: the sources (unique by path) and how many chunks were retrieved. */
  sources: { citations: Citation[]; count: number };
  /** One piece of the answer. */
  token: { text: string };
  /** The answer is complete and stored. Usage is `null` when the model did not report it. */
  done: { citations: Citation[]; input_tokens: number | null; output_tokens: number | null };
  /** A failure after the first frame; the stream ends. A bounded kind, never a message. */
  error: { error_kind: string };
}

/** One SSE frame, with the data typed for its event. */
export function askFrame<K extends keyof AskFrames>(event: K, data: AskFrames[K]): string {
  return sseFrame(event, data);
}
