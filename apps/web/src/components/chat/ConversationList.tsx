import type { components } from '@/lib/api-types';
import { relativeTime } from '@/lib/relative-time';

/** A row, as `GET /api/v1/conversations` returns it. */
export type ConversationItem = components['schemas']['ConversationSummary'];

interface Props {
  items: ConversationItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Disables the buttons while a request is in flight (the caller owns that state). */
  disabled?: boolean;
  /** Fixes "now" for the relative times; tests only. */
  now?: Date;
}

/** Characters that draw nothing: a title made only of these is as good as empty. */
const BLANK = /[\p{Z}\p{Cc}\p{Cf}\s]/gu;
/** Braille blank (U+2800) and Hangul filler (U+3164) are letters to Unicode but draw nothing. */
const FILLERS = new RegExp(`[${String.fromCodePoint(0x2800, 0x3164)}]`, 'g');

const titleOf = (title: string) =>
  title.replace(BLANK, '').replace(FILLERS, '') ? title.trim() : 'Untitled chat';

/**
 * The conversation sidebar. Presentational only — no state, no fetches.
 * Titles come from stored data: they are rendered as TEXT, in their own `<bdi>`, and clipped
 * by CSS, never as HTML or a link.
 */
export function ConversationList({
  items,
  selectedId = null,
  onSelect,
  onNewChat,
  disabled = false,
  now,
}: Readonly<Props>) {
  return (
    <nav className="flex flex-col gap-3" aria-label="Conversations">
      <button
        type="button"
        onClick={onNewChat}
        disabled={disabled}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        + New chat
      </button>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="conversations-empty">
          No chats yet
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((c) => {
            const selected = c.id === selectedId;
            const when = relativeTime(c.updated_at, now);
            const title = titleOf(c.title);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  disabled={disabled}
                  aria-current={selected ? 'true' : undefined}
                  className={`flex w-full flex-col items-start rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100'
                      : 'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800'
                  }`}
                >
                  <bdi className="w-full truncate font-medium" title={title}>
                    {title}
                  </bdi>
                  {when && <span className="text-xs opacity-60">{when}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
