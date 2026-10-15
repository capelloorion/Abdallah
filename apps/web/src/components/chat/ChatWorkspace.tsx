'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeText, type StreamError } from '@/lib/chat-client';
import { DEFAULT_CONVERSATION_TITLE, MAX_TITLE_UNITS } from '@/lib/conversation-limits';
import { rateLimitedMessage } from '@/lib/user-messages';
import {
  askEndpoint,
  createConversation,
  getConversation,
  listConversations,
  type ConversationSummary,
  type ConversationThread,
} from '@/lib/conversations-client';
import { ChatPanel } from './ChatPanel';
import { ConversationDrawer } from './ConversationDrawer';
import { ConversationList } from './ConversationList';

/** The red line for a failed list/create/load: the error code and the trace id, as text. */
function Failure({
  what,
  error,
  onRetry,
}: Readonly<{ what: string; error: StreamError; onRetry?: () => void }>) {
  return (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
      {error.code === 'rate_limited'
        ? rateLimitedMessage(error.retryAfterSeconds)
        : `${what} (${error.code}).`}
      {error.traceId ? (
        <>
          {' '}
          Trace id: <code className="break-all font-mono">{error.traceId}</code>.
        </>
      ) : null}
      {onRetry ? (
        <>
          {' '}
          <button type="button" onClick={onRetry} className="underline">
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}

type ThreadState =
  | { kind: 'none' }
  | { kind: 'loading'; id: string }
  | { kind: 'error'; id: string; error: StreamError }
  | { kind: 'ready'; thread: ConversationThread };

/**
 * The `/chat` screen: the conversation list on the left, the selected conversation on the right.
 * It owns the list, the selection and the load states; `ChatPanel` owns one conversation's
 * streaming. All data comes from the same-origin BFF (`conversations-client`) and is rendered as
 * text only.
 *
 * Several things can be in flight (opening a chat, creating one). The newest user action wins:
 * starting one cancels or outranks the rest, and nothing is disabled, so a keyboard user's focus
 * is never dropped by the button they just pressed.
 */
export function ChatWorkspace() {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<StreamError | null>(null);
  const [actionError, setActionError] = useState<StreamError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadState>({ kind: 'none' });
  // Focus the input after a deliberate action that left a conversation open, not on first paint.
  const [focusInput, setFocusInput] = useState(false);
  // Below 768 px the list is a drawer; this is whether it is open (it is never open at two columns).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const listRef = useRef<AbortController | null>(null);
  const loadRef = useRef<AbortController | null>(null);
  const createRef = useRef<AbortController | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Bumped by every open / new chat: an older action's result is ignored. */
  const actionRef = useRef(0);

  const loadList = useCallback(() => {
    listRef.current?.abort();
    const controller = new AbortController();
    listRef.current = controller;
    setListState('loading');
    void listConversations(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setItems(result.data);
        setListError(null);
        setListState('ready');
      } else {
        setListError(result.error);
        setListState('error');
      }
    });
  }, []);

  useEffect(() => {
    loadList();
    return () => {
      listRef.current?.abort();
      loadRef.current?.abort();
      createRef.current?.abort();
    };
  }, [loadList]);

  const select = useCallback((id: string) => {
    if (id === selectedRef.current) return; // already open: keep what is typed
    ++actionRef.current; // outranks a new chat that is still being created
    selectedRef.current = id;
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    setActionError(null);
    setSelectedId(id);
    setThread({ kind: 'loading', id });
    void getConversation(id, controller.signal).then((result) => {
      if (controller.signal.aborted) return; // a newer open (or a finished new chat) cancelled it
      if (result.ok) {
        setFocusInput(true);
        setThread({ kind: 'ready', thread: result.data });
      } else {
        selectedRef.current = null; // clicking the row again retries
        setThread({ kind: 'error', id, error: result.error });
      }
    });
  }, []);

  /**
   * An answer finished: the chat moves to the top of the list, and one still called "New
   * conversation" takes its first question (cut to 200 characters) as its title — the rule the api
   * applies when it stores the answer, so the list matches what a reload shows.
   */
  const answered = useCallback((id: string, question: string) => {
    const firstQuestion = sanitizeText(
      Array.from(question).slice(0, MAX_TITLE_UNITS).join(''), // code points, as the api cuts
      4 * MAX_TITLE_UNITS, // sanitizing only removes characters; never cut a surrogate pair here
    ).trim();
    const now = new Date().toISOString();
    setItems((prev) => {
      const current = prev.find((c) => c.id === id);
      if (!current) return prev;
      const title =
        current.title === DEFAULT_CONVERSATION_TITLE && firstQuestion
          ? firstQuestion
          : current.title;
      return [{ ...current, title, updated_at: now }, ...prev.filter((c) => c.id !== id)];
    });
  }, []);

  const newChat = useCallback(() => {
    const action = ++actionRef.current;
    createRef.current?.abort();
    const controller = new AbortController();
    createRef.current = controller;
    setActionError(null);
    void createConversation(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        if (action === actionRef.current) setActionError(result.error);
        return;
      }
      const created = result.data;
      // The chat exists now, so it joins the list even when the person has since opened another.
      setItems((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      if (action !== actionRef.current) return;
      loadRef.current?.abort();
      selectedRef.current = created.id;
      setSelectedId(created.id);
      setFocusInput(true);
      setThread({
        kind: 'ready',
        thread: { id: created.id, title: created.title, messages: [], truncated: false },
      });
    });
  }, []);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 md:grid-cols-[16rem_1fr]">
      <h1 className="sr-only">Team Assistant</h1>
      <ConversationDrawer
        open={drawerOpen}
        onOpen={openDrawer}
        onClose={closeDrawer}
        id="conversation-drawer"
      >
        {listState === 'loading' ? (
          <p role="status" className="text-sm text-neutral-500" data-testid="conversations-loading">
            Loading chats…
          </p>
        ) : null}
        {listState === 'error' && listError ? (
          <Failure what="Could not load your chats" error={listError} onRetry={loadList} />
        ) : null}
        {listState !== 'loading' ? (
          <ConversationList
            items={items}
            selectedId={selectedId}
            onSelect={(id) => {
              setDrawerOpen(false);
              select(id);
            }}
            onNewChat={() => {
              setDrawerOpen(false);
              newChat();
            }}
            unavailable={listState === 'error'}
          />
        ) : null}
      </ConversationDrawer>
      <section className="min-w-0" aria-label="Chat">
        {/* Outside the drawer: below 768 px the drawer has already closed when a new chat fails. */}
        {actionError ? <Failure what="Could not start a new chat" error={actionError} /> : null}
        {thread.kind === 'none' ? (
          <p role="status" className="text-sm text-neutral-500" data-testid="chat-pick">
            {items.length === 0 && listState === 'ready'
              ? 'Start a new chat to ask a question.'
              : 'Pick a chat, or start a new one.'}
          </p>
        ) : null}
        {thread.kind === 'loading' ? (
          <p role="status" className="text-sm text-neutral-500" data-testid="thread-loading">
            Loading the conversation…
          </p>
        ) : null}
        {thread.kind === 'error' ? (
          <Failure what="Could not open this chat" error={thread.error} />
        ) : null}
        {thread.kind === 'ready' ? (
          <>
            {thread.thread.truncated ? (
              <p className="mb-2 text-xs text-neutral-500" data-testid="thread-truncated">
                Only the most recent messages are shown.
              </p>
            ) : null}
            <ChatPanel
              key={thread.thread.id}
              endpoint={askEndpoint(thread.thread.id)}
              title={
                items.find((c) => c.id === thread.thread.id)?.title.trim() ||
                thread.thread.title.trim() ||
                'Untitled chat'
              }
              initialMessages={thread.thread.messages}
              autoFocus={focusInput}
              headingLevel={2}
              onAnswered={(question) => answered(thread.thread.id, question)}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
