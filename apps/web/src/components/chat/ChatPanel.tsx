'use client';

import { useEffect, useRef, useState } from 'react';
import { askStream } from '@/lib/chat-client';
import { MAX_QUESTION_CHARS } from '@/lib/conversation-limits';
import { ChatThread } from './ChatThread';
import { rateLimitedMessage } from '@/lib/user-messages';
import { MessageInput } from './MessageInput';
import type { ChatMessage } from './types';

interface Props {
  /** Same-origin SSE route, e.g. `/api/v1/conversations/{id}/ask/stream` (the BFF rule: never the api). */
  endpoint: string;
  title?: string;
  /** Messages already stored for this conversation (already parsed and sanitized). */
  initialMessages?: ChatMessage[];
  /** Focus the input on mount. */
  autoFocus?: boolean;
  /** The heading level of the title; the page owns the h1 when it embeds the panel. */
  headingLevel?: 1 | 2;
  /** The longest question the input accepts, in characters. */
  maxQuestionChars?: number;
  /** Called with the question once its answer is complete (`done`) — not on an error or a cancel. */
  onAnswered?: (question: string) => void;
}

/**
 * The most answer text one reply may accumulate in the browser. A runaway or hostile stream is
 * stopped here (the answer is kept and marked incomplete) instead of growing the page forever.
 */
export const MAX_ANSWER_CHARS = 100_000;

let counter = 0;
/** Live ids start with `live-`; stored ids are `stored-<n>` (conversations-client), so they never collide. */
const nextId = () => `live-${++counter}`;

/** A complete streaming chat surface: thread + input, wired to a BFF SSE route. */
export function ChatPanel({
  endpoint,
  title = 'Assistant',
  initialMessages,
  autoFocus = false,
  headingLevel = 1,
  maxQuestionChars = MAX_QUESTION_CHARS,
  onAnswered,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // A question refused before anything happened (rate limit): a notice, and the question back in
  // the box. Neither the question nor an empty answer is left in the thread.
  const [notice, setNotice] = useState<{ retryAfterSeconds?: number; traceId?: string } | null>(
    null,
  );
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);

  // Leaving the page cancels the request, which lets the api stop the model call.
  useEffect(() => () => abortRef.current?.abort(), []);

  // "Try again in 5 seconds" must not still be on screen long after those seconds have passed.
  useEffect(() => {
    if (!notice?.retryAfterSeconds) return;
    const timer = setTimeout(() => setNotice(null), notice.retryAfterSeconds * 1000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function send(question: string) {
    setNotice(null);
    const assistantId = nextId();
    const userId = nextId();
    // Every callback patches ITS OWN assistant message, never "the last one", so a late callback
    // from an earlier request can never land on a newer answer.
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: question },
      { id: assistantId, role: 'assistant', text: '', pending: true },
    ]);
    setBusy(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let received = 0;
    let capped = false;
    // Something of the answer has arrived (sources or text): then the exchange is not a clean refusal
    // and must stay in the thread, whatever the error is.
    let sawContent = false;
    await askStream(
      endpoint,
      question,
      {
        // The sources block appears as soon as the `sources` frame arrives, before any token.
        onSources: (citations) => {
          if (citations.length) sawContent = true;
          patch((m) => ({ ...m, citations }));
        },
        onToken: (text) => {
          if (capped) return;
          if (text) sawContent = true;
          received += text.length;
          if (received > MAX_ANSWER_CHARS) {
            capped = true;
            controller.abort(); // stop reading; the abort handler below keeps the error we set
            patch((m) => ({ ...m, pending: false, error: 'answer_too_long' }));
            return;
          }
          patch((m) => ({ ...m, text: m.text + text }));
        },
        onDone: ({ citations }) => {
          patch((m) => ({
            ...m,
            pending: false,
            // a `done` frame may list no citations of its own: keep the ones from `sources`
            citations: citations.length ? citations : m.citations,
          }));
          if (!capped) onAnswered?.(question);
        },
        onError: ({ code, traceId, retryAfterSeconds }) => {
          if (code === 'rate_limited' && !sawContent) {
            // Refused before any of the answer: nothing happened, so the question goes back to the
            // input. (A `rate_limited` frame after text has streamed takes the normal path below:
            // the partial answer is kept and marked incomplete.)
            setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== userId));
            setNotice({ retryAfterSeconds, traceId });
            setRestore((r) => ({ text: question, nonce: (r?.nonce ?? 0) + 1 }));
          } else if (code !== 'aborted') {
            patch((m) => ({ ...m, pending: false, error: code, traceId }));
          } else if (!capped) {
            // Cancelled (leaving the page, sending again): a half answer must not look finished,
            // and an empty placeholder is just removed.
            setMessages((prev) =>
              prev.flatMap((m) => {
                if (m.id !== assistantId) return [m];
                if (!m.text && !m.citations?.length) return [];
                return [{ ...m, pending: false, error: m.error ?? 'aborted' }];
              }),
            );
          }
        },
      },
      { signal: controller.signal },
    );
    setBusy(false);
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4" aria-label={title}>
      <Heading className="text-xl font-semibold">{title}</Heading>
      <div className="min-h-[16rem] rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <ChatThread messages={messages} />
      </div>
      {notice ? (
        <p
          role="alert"
          data-testid="rate-limited"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          {rateLimitedMessage(notice.retryAfterSeconds)}
          {notice.traceId ? (
            <>
              {' '}
              Trace id: <code className="break-all font-mono">{notice.traceId}</code>.
            </>
          ) : null}
        </p>
      ) : null}
      <MessageInput
        onSubmit={send}
        disabled={busy}
        autoFocus={autoFocus}
        maxChars={maxQuestionChars}
        restore={restore}
      />
    </section>
  );
}
