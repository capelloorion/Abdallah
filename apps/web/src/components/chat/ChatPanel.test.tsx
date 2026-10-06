// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseFrame, sseStreamFromFrames } from '@/lib/sse';
import { ChatPanel, MAX_ANSWER_CHARS } from './ChatPanel';

const TRACE = '0eb01' + 'c'.repeat(27);
const API = { title: 'The api service', path: 'docs/api.md' };
const ENDPOINT = '/api/v1/assistant/ask/stream';

function stream(frames: string[], init: ResponseInit & { trace?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (init.trace) headers['x-trace-id'] = init.trace;
  return new Response(sseStreamFromFrames(frames), { status: init.status ?? 200, headers });
}

async function ask(question: string) {
  const user = userEvent.setup();
  render(<ChatPanel endpoint={ENDPOINT} />);
  await user.type(screen.getByLabelText('Message'), `${question}{Enter}`);
  return user;
}

describe('<ChatPanel />', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('streams an answer into the thread and shows its sources as title and path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stream([
        sseFrame('sources', { citations: [API], count: 1 }),
        sseFrame('token', { text: 'Port ' }),
        sseFrame('token', { text: '8000' }),
        sseFrame('done', { citations: [API] }),
      ]),
    );
    await ask('which port?');

    await waitFor(() => expect(screen.getByText('Port 8000')).toBeInTheDocument());
    expect(screen.getByText('which port?')).toBeInTheDocument();
    const sources = screen.getByLabelText('Sources');
    expect(within(sources).getByText('The api service')).toBeInTheDocument();
    expect(within(sources).getByText('docs/api.md')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const [url] = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(url).toBe(ENDPOINT); // same-origin only
  });

  it('shows the sources as soon as their frame arrives, while the answer is still streaming', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const enc = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    await ask('which port?');

    controller.enqueue(enc.encode(sseFrame('sources', { citations: [API], count: 1 })));
    await waitFor(() => expect(screen.getByLabelText('Sources')).toHaveTextContent('docs/api.md'));
    expect(screen.getByLabelText('Streaming')).toBeInTheDocument(); // still streaming, no token yet

    controller.enqueue(enc.encode(sseFrame('token', { text: 'Port 8000' })));
    controller.enqueue(enc.encode(sseFrame('done', { citations: [API] })));
    controller.close();
    await waitFor(() => expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument());
    expect(screen.getByText('Port 8000')).toBeInTheDocument();
  });

  it("surfaces the api's error code and trace id when the request fails before the stream", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'ai_unavailable', trace_id: TRACE }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await ask('q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong (ai_unavailable).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);
    expect(screen.getByText('q')).toBeInTheDocument(); // the question stays on screen
  });

  it('shows why when the api is unreachable (the BFF 502 event-stream body)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stream([sseFrame('error', { error_kind: 'upstream_unreachable' })], {
        status: 502,
        trace: TRACE,
      }),
    );
    await ask('q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('(upstream_unreachable)');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);
  });

  it('keeps what streamed and marks the answer incomplete when an error frame arrives', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stream(
        [
          sseFrame('sources', { citations: [API], count: 1 }),
          sseFrame('token', { text: 'The trace id is' }),
          sseFrame('error', { error_kind: 'timeout' }),
        ],
        { trace: TRACE },
      ),
    );
    await ask('q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The answer is incomplete (timeout).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}`);
    expect(screen.getByText('The trace id is')).toBeInTheDocument();
    expect(screen.getByLabelText('Sources')).toHaveTextContent('docs/api.md');
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });

  it('never presents a stream that was cut off as a complete answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stream([sseFrame('token', { text: 'half an ans' })], { trace: TRACE }),
    );
    await ask('q');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The answer is incomplete (stream_ended).');
    expect(screen.getByText('half an ans')).toBeInTheDocument();
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });

  it('lets the person ask again after a failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('x', { status: 502 }))
      .mockResolvedValueOnce(
        stream([sseFrame('token', { text: 'It works' }), sseFrame('done', { citations: [] })]),
      );
    const user = await ask('first');
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());

    await user.type(screen.getByLabelText('Message'), 'second{Enter}');
    await waitFor(() => expect(screen.getByText('It works')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('alert')).toHaveLength(1); // the first failure is still shown
  });

  it('falls back to a status-class code for a plain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 502 }));
    await ask('q');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('upstream_error'));
  });

  it('does not report an aborted request as a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await ask('q');
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });
});

describe('<ChatPanel /> limits and cancellation', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const enc = new TextEncoder();
  const controlled = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    return { response, push: (frame: string) => controller.enqueue(enc.encode(frame)), controller };
  };

  it('stops an answer that grows past the limit, keeps what came before and says so', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        stream([
          sseFrame('token', { text: 'ok ' }),
          sseFrame('token', { text: 'y'.repeat(MAX_ANSWER_CHARS + 1) }),
          sseFrame('token', { text: 'never shown' }),
          sseFrame('done', { citations: [] }),
        ]),
      );
    const { container } = render(<ChatPanel endpoint={ENDPOINT} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'q{Enter}');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The answer is incomplete (answer_too_long).');
    expect(container.textContent).toContain('ok');
    expect(container.textContent).not.toContain('never shown');
    expect(container.textContent!.length).toBeLessThan(MAX_ANSWER_CHARS); // the big token was dropped
    expect((spy.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true); // reading stopped
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
  });

  it('aborts the request when the page is left', async () => {
    const { response } = controlled();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const { unmount } = render(<ChatPanel endpoint={ENDPOINT} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'q{Enter}');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const signal = (spy.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('marks a half answer as incomplete when the request is cancelled', async () => {
    const { response, push, controller } = controlled();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await ask('q');
    push(sseFrame('token', { text: 'half an ans' }));
    await waitFor(() => expect(screen.getByText('half an ans')).toBeInTheDocument());
    controller.error(new DOMException('cancelled', 'AbortError'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The answer is incomplete (aborted).');
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });

  it('removes the empty placeholder when a request is cancelled before anything arrived', async () => {
    const { response, controller } = controlled();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await ask('the question');
    controller.error(new DOMException('cancelled', 'AbortError'));

    await waitFor(() => expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument());
    expect(screen.getByText('the question')).toBeInTheDocument(); // the question stays
    expect(within(screen.getByLabelText('Conversation')).queryByText('Assistant')).toBeNull(); // the empty bubble is gone
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses to send to an endpoint that is not a same-origin path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<ChatPanel endpoint="https://evil.example/ask" />);
    await user.type(screen.getByLabelText('Message'), 'q{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('bad_endpoint');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
