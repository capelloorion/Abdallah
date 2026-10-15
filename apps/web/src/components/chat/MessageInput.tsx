'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Focus the textarea when it mounts (a new or reopened conversation). */
  autoFocus?: boolean;
  /** The longest question, in characters (code points, as the api counts). Shows `n / max`. */
  maxChars?: number;
  /**
   * Put a question back in the box (it was refused before anything happened, e.g. rate-limited).
   * Applied once per `nonce`, and only if the person has not typed something else meanwhile.
   */
  restore?: { text: string; nonce: number } | null;
}

/** Textarea + send button. Enter sends, Shift+Enter inserts a newline. */
export function MessageInput({
  onSubmit,
  disabled = false,
  placeholder = 'Ask a question…',
  autoFocus = false,
  maxChars,
  restore = null,
}: Props) {
  const [text, setText] = useState('');
  const counterId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  // A disabled box drops keyboard focus. If the person was typing here, hand focus back when the box
  // is enabled again (an answer finished, failed or was cancelled) so they can keep going.
  const hadFocus = useRef(autoFocus);
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (wasDisabled.current && !disabled && hadFocus.current) {
      // only if focus was lost (or is still parked on the box), never if the person moved elsewhere
      const active = document.activeElement;
      if (!active || active === document.body || active === box.current) box.current?.focus();
    }
    wasDisabled.current = disabled;
  }, [disabled]);
  useEffect(() => {
    // Only into an empty box: what the person typed meanwhile is never overwritten. (The box is
    // disabled while an answer is pending, so it is empty when a refusal comes back; a draft
    // feature that changes that must also decide where the refused question goes.)
    if (restore) setText((current) => (current.trim() === '' ? restore.text : current));
    // once per nonce: a re-render with the same restore must not overwrite what is typed later
  }, [restore?.nonce]);
  const trimmed = text.trim();
  // Code points, like the api. A huge paste is over the limit whatever it is, so skip the walk.
  const count =
    maxChars !== undefined && trimmed.length <= maxChars * 2
      ? Array.from(trimmed).length
      : trimmed.length;
  const tooLong = maxChars !== undefined && count > maxChars;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    onSubmit(text.trim());
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2" aria-label="Message form">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        ref={box}
        onFocus={() => {
          hadFocus.current = true;
        }}
        onBlur={(e) => {
          // a blur caused by the box being disabled is not the person leaving it
          if (!e.currentTarget.disabled) hadFocus.current = false;
        }}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={2}
        placeholder={placeholder}
        aria-label="Message"
        aria-describedby={maxChars !== undefined ? counterId : undefined}
        aria-invalid={tooLong || undefined}
        className="flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      {maxChars !== undefined ? (
        <p
          id={counterId}
          data-testid="question-counter"
          className={`self-center text-xs ${tooLong ? 'text-red-600 dark:text-red-400' : 'text-neutral-500'}`}
        >
          {count.toLocaleString('en-US')} / {maxChars.toLocaleString('en-US')}
          {tooLong ? ' — too long to send' : ''}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {tooLong ? 'Too long to send' : ''}
      </span>
      <button
        type="submit"
        disabled={!canSend}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
