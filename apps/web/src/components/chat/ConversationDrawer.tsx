'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** The element id the toggle button controls. */
  id: string;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The conversation column. From 768 px up it is a plain column (the toggle is hidden and the
 * panel is always shown). Below that it collapses behind a **Chats** button and opens as a drawer
 * over the page, a modal dialog while open: focus moves in, Tab stays inside (wherever focus is,
 * even on the page body after a click), **Esc**, the backdrop or **Close** dismiss it and hand
 * focus back to the button, and the button reports `aria-expanded`. The caller closes it when a
 * row is picked or a chat is started: focus then goes where that action sends it, or, when it
 * sends it nowhere (the chat was already open, the request failed), back to the button.
 *
 * It owns no data: `children` is whatever the column shows.
 */
export function ConversationDrawer({ open, onOpen, onClose, id, children }: Readonly<Props>) {
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  // Set when the person dismissed the drawer (Esc, backdrop, Close): focus goes back to the button.
  const restoreFocus = useRef(false);

  const dismiss = useCallback(() => {
    restoreFocus.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    } else if (wasOpen.current) {
      if (restoreFocus.current) {
        opener.current?.focus();
      } else {
        // An action inside closed it. If it did not move focus anywhere, focus is on the page
        // body (the focused button just disappeared): give it to the toggle, not to nowhere.
        timer = setTimeout(() => {
          const active = document.activeElement;
          if (!active || active === document.body) opener.current?.focus();
        }, 0);
      }
    }
    restoreFocus.current = false;
    wasOpen.current = open;
    return () => clearTimeout(timer);
  }, [open]);

  // Resizing to two columns while the drawer is open: it is a column again, so close it.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (wide.matches) onClose();
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [open, onClose]);

  // Esc and the Tab trap are listened for on the document while open, so they still work when
  // focus has fallen to the page body (a click on blank space in the drawer, a re-rendered row).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.current?.contains(active)) {
        e.preventDefault(); // focus is outside the dialog: bring it back in
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dismiss]);

  return (
    <>
      <div className="md:hidden">
        <button
          ref={opener}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => (open ? dismiss() : onOpen())}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          Chats
        </button>
      </div>
      {open ? (
        <div
          className="fixed inset-0 z-10 bg-black/40 md:hidden"
          aria-hidden="true"
          data-testid="drawer-backdrop"
          onClick={dismiss}
        />
      ) : null}
      <aside
        id={id}
        ref={panel}
        {...(open
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Chats', tabIndex: -1 }
          : {})}
        className={`flex-col gap-3 md:static md:z-auto md:flex md:w-auto md:max-w-none md:overflow-visible md:bg-transparent md:p-0 md:shadow-none ${
          open
            ? 'fixed inset-y-0 left-0 z-20 flex w-72 max-w-[85%] overflow-y-auto bg-white p-4 shadow-xl focus:outline-none dark:bg-neutral-900'
            : 'hidden'
        }`}
      >
        {open ? (
          <button
            type="button"
            onClick={dismiss}
            className="self-end rounded-lg px-2 py-1 text-sm text-neutral-700 underline md:hidden dark:text-neutral-300"
          >
            Close
          </button>
        ) : null}
        {children}
      </aside>
    </>
  );
}
