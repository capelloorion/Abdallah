'use client';

import { useEffect, useRef, useState } from 'react';
import { askStream } from '@/lib/chat-client';
import { ChatThread } from './ChatThread';
import { MessageInput } from './MessageInput';
import type { ChatMessage } from './types';

interface Props {
  /** Same-origin SSE route, e.g. `/api/v1/assistant/ask/stream` (the BFF rule: never the api). */
  endpoint: string;
  title?: string;
}

/**
 * The most answer text one reply may accumulate in the browser. A runaway or hostile stream is
 * stopped here (the answer is kept and marked incomplete) instead of growing the page forever.
 */
export const MAX_ANSWER_CHARS = 100_000;

let counter = 0;
const nextId = () => `m${++counter}`;

/** A complete streaming chat surface: thread + input, wired to a BFF SSE route. */
export function ChatPanel({ endpoint, title = 'Assistant' }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page cancels the request, which lets the api stop the model call.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(question: string) {
    const assistantId = nextId();
    // Every callback patches ITS OWN assistant message, never "the last one", so a late callback
    // from an earlier request can never land on a newer answer.
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text: question },
      { id: assistantId, role: 'assistant', text: '', pending: true },
    ]);
    setBusy(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let received = 0;
    let capped = false;
    await askStream(
      endpoint,
      question,
      {
        // The sources block appears as soon as the `sources` frame arrives, before any token.
        onSources: (citations) => patch((m) => ({ ...m, citations })),
        onToken: (text) => {
          if (capped) return;
          received += text.length;
          if (received > MAX_ANSWER_CHARS) {
            capped = true;
            controller.abort(); // stop reading; the abort handler below keeps the error we set
            patch((m) => ({ ...m, pending: false, error: 'answer_too_long' }));
            return;
          }
          patch((m) => ({ ...m, text: m.text + text }));
        },
        onDone: ({ citations }) =>
          patch((m) => ({
            ...m,
            pending: false,
            // a `done` frame may list no citations of its own: keep the ones from `sources`
            citations: citations.length ? citations : m.citations,
          })),
        onError: ({ code, traceId }) => {
          if (code !== 'aborted') {
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
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="min-h-[16rem] rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <ChatThread messages={messages} />
      </div>
      <MessageInput onSubmit={send} disabled={busy} />
    </section>
  );
}
