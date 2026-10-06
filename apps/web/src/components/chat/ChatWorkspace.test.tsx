// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseFrame, sseStreamFromFrames } from '@/lib/sse';
import { ChatWorkspace } from './ChatWorkspace';

const ID_A = '3f2b9c1e-5a47-4d8e-9b6a-1c0d2e3f4a51';
const ID_B = '7a1d4e92-0b3c-4f65-8e21-9d8c7b6a5f42';
const ID_NEW = 'c5e8a0b7-2d94-4a13-b7f6-4e3d2c1b0a93';
const TRACE = '0eb01' + 'e'.repeat(27);
const API = { title: 'The api service', path: 'docs/api.md' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (error: string, status: number) => json({ error, trace_id: TRACE }, status);

const SUMMARIES = [
  { id: ID_A, title: 'Trace ids', updated_at: '2026-10-06T09:05:00Z' },
  { id: ID_B, title: 'Error contract', updated_at: '2026-10-05T16:31:00Z' },
];
const detail = (id: string, title: string, messages: unknown[] = [], truncated = false) => ({
  id,
  title,
  truncated,
  created_at: '2026-10-06T09:00:00Z',
  updated_at: '2026-10-06T09:05:00Z',
  messages,
});
const DETAIL_A = detail(ID_A, 'Trace ids', [
  { id: 'm1', role: 'user', content: 'How does it work?', citations: null, created_at: 'x' },
  {
    id: 'm2',
    role: 'assistant',
    content: 'It is minted by the BFF [1].',
    citations: [API],
    created_at: 'x',
  },
]);

type Route = (init: RequestInit) => Response | Promise<Response>;
/** A fetch that answers by "METHOD path"; anything unlisted fails the test loudly. */
function routes(table: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`;
    const handler = table[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init ?? {});
  });
}
const LIST = 'GET /api/v1/conversations';
const CREATE = 'POST /api/v1/conversations';
const open = (id: string) => `GET /api/v1/conversations/${id}`;

describe('<ChatWorkspace />', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the conversation list on mount', async () => {
    const f = routes({ [LIST]: () => json({ items: SUMMARIES, count: 2 }) });
    render(<ChatWorkspace />);
    expect(screen.getByTestId('conversations-loading')).toBeInTheDocument();
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(within(list).getByText('Trace ids')).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-pick')).toHaveTextContent('Pick a chat');
  });

  it('shows "No chats yet" and a hint when there are none', async () => {
    routes({ [LIST]: () => json({ items: [], count: 0 }) });
    render(<ChatWorkspace />);
    expect(await screen.findByTestId('conversations-empty')).toHaveTextContent('No chats yet');
    expect(screen.getByTestId('chat-pick')).toHaveTextContent('Start a new chat');
  });

  it('shows the error code and trace id when the list cannot load, and still offers + New chat', async () => {
    routes({ [LIST]: () => err('upstream_unreachable', 502) });
    render(<ChatWorkspace />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your chats (upstream_unreachable).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);
    expect(screen.getByRole('button', { name: '+ New chat' })).toBeEnabled();
  });

  it('opens a conversation: its messages with their sources, then the input continues it', async () => {
    const ask = vi.fn(
      () =>
        new Response(
          sseStreamFromFrames([
            sseFrame('token', { text: 'More' }),
            sseFrame('done', { citations: [] }),
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => json(DETAIL_A),
      [`POST /api/v1/conversations/${ID_A}/ask/stream`]: ask,
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));

    const thread = await screen.findByLabelText('Conversation');
    expect(within(thread).getByText('How does it work?')).toBeInTheDocument();
    expect(within(thread).getByText(/It is minted by the BFF/)).toBeInTheDocument();
    expect(within(thread).getByLabelText('Sources')).toHaveTextContent('docs/api.md');
    expect(screen.getByRole('button', { name: /Trace ids/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByLabelText('Message')).toHaveFocus();

    await user.type(screen.getByLabelText('Message'), 'and then?{Enter}');
    await waitFor(() => expect(screen.getByText('More')).toBeInTheDocument());
    expect(ask).toHaveBeenCalledTimes(1); // posted to THIS conversation's ask-stream route
    expect(
      within(screen.getByLabelText('Conversation')).getByText('How does it work?'),
    ).toBeInTheDocument();
  });

  it('notes when older messages were left out', async () => {
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => json({ ...DETAIL_A, truncated: true }),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    expect(await screen.findByTestId('thread-truncated')).toBeInTheDocument();
  });

  it('shows the error code and trace id when a conversation cannot be opened, and a second click retries', async () => {
    let calls = 0;
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => (++calls === 1 ? err('not_found', 404) : json(DETAIL_A)),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not open this chat (not_found).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);

    await user.click(screen.getByRole('button', { name: /Trace ids/ }));
    expect(await screen.findByText('How does it work?')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never shows a stored message as an error line', async () => {
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () =>
        json(
          detail(ID_A, 'Trace ids', [
            {
              id: 'm1',
              role: 'assistant',
              content: 'Something went wrong (fake). Trace id: 123',
              citations: null,
              error: 'boom',
              traceId: TRACE,
              created_at: 'x',
            },
          ]),
        ),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    await screen.findByText(/Something went wrong \(fake\)/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // plain text, not the red line
  });

  it('+ New chat creates a conversation, puts it first, selects it and focuses the input', async () => {
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [CREATE]: () =>
        json({ id: ID_NEW, title: 'New conversation', updated_at: '2026-10-06T12:00:00Z' }, 201),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await screen.findByRole('list');
    await user.click(screen.getByRole('button', { name: '+ New chat' }));

    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveFocus());
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('New conversation');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
  });

  it('+ New chat works from the empty state', async () => {
    routes({
      [LIST]: () => json({ items: [], count: 0 }),
      [CREATE]: () =>
        json({ id: ID_NEW, title: 'New conversation', updated_at: '2026-10-06T12:00:00Z' }, 201),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await screen.findByTestId('conversations-empty');
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeInTheDocument());
    expect(screen.queryByTestId('conversations-empty')).not.toBeInTheDocument();
  });

  it('shows why a new chat could not be started and leaves the current chat alone', async () => {
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => json(DETAIL_A),
      [CREATE]: () => err('upstream_error', 502),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    await screen.findByText('How does it work?');
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start a new chat (upstream_error).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);
    expect(screen.getByText('How does it work?')).toBeInTheDocument();
  });

  it('keeps the newest open when an older one answers late', async () => {
    let releaseA!: (r: Response) => void;
    let signalA: AbortSignal | null | undefined;
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: (init) => {
        signalA = init.signal;
        return new Promise<Response>((resolve) => {
          releaseA = resolve;
        });
      },
      [open(ID_B)]: () =>
        json(
          detail(ID_B, 'Error contract', [
            { id: 'b1', role: 'user', content: 'B question', citations: null, created_at: 'x' },
          ]),
        ),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    expect(screen.getByTestId('thread-loading')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Error contract/ })); // A is still loading
    expect(await screen.findByText('B question')).toBeInTheDocument();
    expect(signalA?.aborted).toBe(true);
    releaseA(json(DETAIL_A)); // too late: must not replace B
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('B question')).toBeInTheDocument();
    expect(screen.queryByText('How does it work?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Error contract/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('adds a new chat to the list but keeps the one the person opened meanwhile', async () => {
    let releaseCreate!: (r: Response) => void;
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_B)]: () => json(detail(ID_B, 'Error contract', [])),
      [CREATE]: () =>
        new Promise<Response>((resolve) => {
          releaseCreate = resolve;
        }),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await screen.findByRole('list');
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    await user.click(screen.getByRole('button', { name: /Error contract/ }));
    await screen.findByRole('heading', { level: 2, name: 'Error contract' });
    releaseCreate(
      json({ id: ID_NEW, title: 'New conversation', updated_at: '2026-10-06T12:00:00Z' }, 201),
    );
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(3),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Error contract' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Error contract/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('does not say "No chats yet" when the list failed, and "Try again" reloads it', async () => {
    let calls = 0;
    routes({
      [LIST]: () =>
        ++calls === 1 ? err('upstream_error', 502) : json({ items: SUMMARIES, count: 2 }),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    expect(await screen.findByRole('alert')).toHaveTextContent('upstream_error');
    expect(screen.queryByTestId('conversations-empty')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps keyboard focus on the row when opening it fails, so Enter can retry', async () => {
    let calls = 0;
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => (++calls === 1 ? err('not_found', 404) : json(DETAIL_A)),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    const row = await screen.findByRole('button', { name: /Trace ids/ });
    row.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');
    expect(row).toHaveFocus(); // a disabled button would have dropped focus to the page
    await user.keyboard('{Enter}');
    expect(await screen.findByText('How does it work?')).toBeInTheDocument();
  });

  it('keeps what was typed when the open chat is clicked again, and shows its title', async () => {
    const f = routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [open(ID_A)]: () => json(DETAIL_A),
    });
    const user = userEvent.setup();
    render(<ChatWorkspace />);
    await user.click(await screen.findByRole('button', { name: /Trace ids/ }));
    await screen.findByRole('heading', { level: 2, name: 'Trace ids' });
    await user.type(screen.getByLabelText('Message'), 'half a question');
    await user.click(screen.getByRole('button', { name: /Trace ids/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('half a question');
    expect(f).toHaveBeenCalledTimes(2); // the list and one open
  });

  it('cancels a create that is still in flight when the page is left', async () => {
    let signal: AbortSignal | null | undefined;
    routes({
      [LIST]: () => json({ items: SUMMARIES, count: 2 }),
      [CREATE]: (init) => {
        signal = init.signal;
        return new Promise<Response>(() => undefined);
      },
    });
    const user = userEvent.setup();
    const { unmount } = render(<ChatWorkspace />);
    await screen.findByRole('list');
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    await waitFor(() => expect(signal).toBeTruthy());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('renders a hostile title as inert text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    routes({
      [LIST]: () => json({ items: [{ ...SUMMARIES[0], title: evil }], count: 1 }),
    });
    render(<ChatWorkspace />);
    const row = await screen.findByRole('button', { name: new RegExp('img src=x') });
    expect(row).toHaveTextContent(evil);
    expect(row.querySelector('img')).toBeNull();
  });

  it('cancels its requests when the page is left', async () => {
    let signal: AbortSignal | null | undefined;
    routes({
      [LIST]: (init) => {
        signal = init.signal;
        return new Promise<Response>(() => undefined);
      },
    });
    const { unmount } = render(<ChatWorkspace />);
    await waitFor(() => expect(signal).toBeTruthy());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
