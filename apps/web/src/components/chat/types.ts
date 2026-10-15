import type { Citation } from '@/lib/chat-client';

export type { Citation };

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Sources the answer drew on (unique by path, in retrieval order). Render as plain text. */
  citations?: Citation[];
  /** Still streaming. */
  pending?: boolean;
  /** Short error code from the api or the client (never raw exception text). */
  error?: string;
  /** The trace id of the failed request, when the server sent one. */
  traceId?: string;
}
