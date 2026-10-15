import type { ChatMessage } from './types';

const ROLE_LABEL: Record<ChatMessage['role'], string> = { user: 'You', assistant: 'Assistant' };

/**
 * The red line under a failed exchange: the error code and, when there is one, the trace id.
 * Both are plain text. An answer that already has text is marked incomplete rather than failed.
 */
function ErrorLine({ message }: Readonly<{ message: ChatMessage }>) {
  const lead = message.text ? 'The answer is incomplete' : 'Something went wrong';
  return (
    <span role="alert" className="mt-2 block text-xs text-red-600 dark:text-red-400">
      {lead} ({message.error}).
      {message.traceId ? (
        <>
          {' '}
          Trace id: <code className="break-all font-mono">{message.traceId}</code>.
        </>
      ) : null}{' '}
      Try again.
    </span>
  );
}

/** The message list. Presentational only — no state, no fetches. */
export function ChatThread({ messages }: Readonly<{ messages: ChatMessage[] }>) {
  if (messages.length === 0) {
    return (
      <p className="text-sm text-neutral-500" data-testid="chat-empty">
        Ask a question to start.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3" aria-live="polite" aria-label="Conversation">
      {messages.map((m) => {
        const hasCitations = Boolean(m.citations && m.citations.length > 0);
        // A failed answer with nothing to show is just the red line, not an empty chat bubble.
        if (m.role === 'assistant' && m.error && !m.text && !hasCitations) {
          return (
            <li
              key={m.id}
              data-role="assistant"
              data-state="error"
              className="max-w-[85%] self-start"
            >
              <ErrorLine message={m} />
            </li>
          );
        }
        return (
          <li
            key={m.id}
            data-role={m.role}
            className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
              m.role === 'user'
                ? 'self-end bg-blue-600 text-white'
                : 'self-start border border-neutral-200 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
            }`}
          >
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide opacity-70">
              {ROLE_LABEL[m.role]}
            </span>
            <span className="whitespace-pre-wrap">{m.text}</span>
            {m.pending && (
              <span className="ml-1 inline-block animate-pulse" aria-label="Streaming">
                …
              </span>
            )}
            {m.error && <ErrorLine message={m} />}
            {hasCitations && (
              // Titles and paths are document content: rendered as TEXT, never as HTML or a link.
              // Each sits in its own <bdi>, so a stray bidi-override character in one cannot
              // reorder the text next to it.
              <ul className="mt-2 flex flex-col gap-1" aria-label="Sources">
                {m.citations!.map((c, i) => (
                  <li
                    key={`${i}:${c.path}`}
                    className="rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    <bdi className="font-medium">{c.title}</bdi>{' '}
                    <bdi className="ml-1 break-all font-mono opacity-70">{c.path}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
