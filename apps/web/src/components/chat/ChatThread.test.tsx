// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatThread } from './ChatThread';

const TRACE = '0eb01' + 'a'.repeat(27);
const API = { title: 'The api service', path: 'docs/api.md' };
const WEB = { title: 'The web app', path: 'docs/web.md' };

describe('<ChatThread />', () => {
  afterEach(cleanup);

  it('shows the empty state', () => {
    render(<ChatThread messages={[]} />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent('Ask a question');
  });

  it('renders user and assistant turns, with the pending marker', () => {
    render(
      <ChatThread
        messages={[
          { id: '1', role: 'user', text: 'Which port?' },
          { id: '2', role: 'assistant', text: 'Port 8000 [1].', pending: true },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-role'));
    expect(items.map((li) => li.getAttribute('data-role'))).toEqual(['user', 'assistant']);
    expect(screen.getByText('Port 8000 [1].')).toBeInTheDocument();
    expect(screen.getByLabelText('Streaming')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('<ChatThread /> sources', () => {
  afterEach(cleanup);

  it('lists each source as its title, then its path, separated for readers and copy-paste', () => {
    render(
      <ChatThread
        messages={[{ id: '2', role: 'assistant', text: 'Answer.', citations: [API, WEB] }]}
      />,
    );
    const sources = within(screen.getByLabelText('Sources'));
    const rows = sources.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('The api service docs/api.md'); // a space, not run together
    expect(rows[1].textContent).toBe('The web app docs/web.md');
    // each in its own <bdi>, so a stray bidi character in one cannot reorder the other
    expect(sources.getByText('The api service').tagName).toBe('BDI');
    expect(sources.getByText('docs/api.md').tagName).toBe('BDI');
  });

  it('shows the sources even while the answer is still streaming (before any token)', () => {
    render(
      <ChatThread
        messages={[{ id: '2', role: 'assistant', text: '', pending: true, citations: [API] }]}
      />,
    );
    expect(screen.getByLabelText('Sources')).toHaveTextContent('docs/api.md');
    expect(screen.getByLabelText('Streaming')).toBeInTheDocument();
  });

  it.each([[undefined], [[]]])('shows no Sources block for %j', (citations) => {
    render(<ChatThread messages={[{ id: '2', role: 'assistant', text: 'Hi', citations }]} />);
    expect(screen.queryByLabelText('Sources')).not.toBeInTheDocument();
  });

  it('renders hostile titles and paths as inert text, never as markup or a link', () => {
    const hostile = {
      title: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      path: 'javascript:alert(3)',
    };
    const { container } = render(
      <ChatThread messages={[{ id: '2', role: 'assistant', text: 'x', citations: [hostile] }]} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getByLabelText('Sources')).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(screen.getByLabelText('Sources')).toHaveTextContent('javascript:alert(3)');
  });

  it('keeps two citations with the same title distinct', () => {
    render(
      <ChatThread
        messages={[
          {
            id: '2',
            role: 'assistant',
            text: 'x',
            citations: [
              { title: 'Setup', path: 'docs/a/setup.md' },
              { title: 'Setup', path: 'docs/b/setup.md' },
            ],
          },
        ]}
      />,
    );
    expect(within(screen.getByLabelText('Sources')).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('<ChatThread /> errors', () => {
  afterEach(cleanup);

  it('shows a failed answer with nothing to show as just the red line, with code and trace id', () => {
    const { container } = render(
      <ChatThread
        messages={[
          { id: '1', role: 'user', text: 'Which port?' },
          { id: '2', role: 'assistant', text: '', error: 'timeout', traceId: TRACE },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong (timeout).');
    expect(alert).toHaveTextContent(`Trace id: ${TRACE}.`);
    expect(alert.querySelector('code')).toHaveTextContent(TRACE);
    expect(alert).toHaveTextContent('Try again.');
    // no empty assistant bubble around it
    expect(container.querySelector('li[data-state="error"]')).not.toBeNull();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    // and it comes after the user message
    const roles = screen
      .getAllByRole('listitem')
      .filter((li) => li.hasAttribute('data-role'))
      .map((li) => li.getAttribute('data-role'));
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('omits the trace id line when the server sent none', () => {
    render(
      <ChatThread messages={[{ id: '2', role: 'assistant', text: '', error: 'network_error' }]} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong (network_error).');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Trace id');
  });

  it('keeps the partial answer and calls it incomplete', () => {
    render(
      <ChatThread
        messages={[
          {
            id: '2',
            role: 'assistant',
            text: 'The trace id is',
            error: 'stream_ended',
            traceId: TRACE,
          },
        ]}
      />,
    );
    expect(screen.getByText('The trace id is')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The answer is incomplete (stream_ended).');
    expect(screen.getByRole('alert')).toHaveTextContent(`Trace id: ${TRACE}`);
    expect(screen.getByText('Assistant')).toBeInTheDocument(); // it is still an assistant bubble
  });

  it('keeps the sources when the failure came after them, even with no text yet', () => {
    render(
      <ChatThread
        messages={[{ id: '2', role: 'assistant', text: '', error: 'timeout', citations: [API] }]}
      />,
    );
    expect(screen.getByLabelText('Sources')).toHaveTextContent('docs/api.md');
    expect(screen.getByRole('alert')).toHaveTextContent('(timeout)');
  });

  it('renders an error code as text, not markup', () => {
    const { container } = render(
      <ChatThread
        messages={[
          { id: '2', role: 'assistant', text: '', error: '<b>x</b>', traceId: '<i>y</i>' },
        ]}
      />,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('<b>x</b>');
  });

  it('shows one alert per failed answer', () => {
    render(
      <ChatThread
        messages={[
          { id: '1', role: 'user', text: 'a' },
          { id: '2', role: 'assistant', text: '', error: 'timeout' },
          { id: '3', role: 'user', text: 'b' },
          { id: '4', role: 'assistant', text: '', error: 'not_found' },
        ]}
      />,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});
