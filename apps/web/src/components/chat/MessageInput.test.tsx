// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MessageInput } from './MessageInput';

describe('<MessageInput />', () => {
  afterEach(cleanup); // Vitest globals are off, so RTL does not auto-clean between tests

  it('sends trimmed text on Enter and clears; Shift+Enter inserts a newline', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MessageInput onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Message');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(box, '  hello  ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(box).toHaveValue('');

    await user.type(box, 'a{Shift>}{Enter}{/Shift}b');
    expect(box).toHaveValue('a\nb');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('focuses the box on mount only when asked to', () => {
    const { unmount } = render(<MessageInput onSubmit={vi.fn()} autoFocus />);
    expect(screen.getByLabelText('Message')).toHaveFocus();
    unmount();
    render(<MessageInput onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Message')).not.toHaveFocus();
  });

  it('is inert while disabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MessageInput onSubmit={onSubmit} disabled />);
    const box = screen.getByLabelText('Message');
    expect(box).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe('with a length limit', () => {
    it('shows the count against the limit and updates as the person types', async () => {
      const user = userEvent.setup();
      render(<MessageInput onSubmit={vi.fn()} maxChars={4000} />);
      expect(screen.getByTestId('question-counter')).toHaveTextContent('0 / 4,000');
      await user.type(screen.getByLabelText('Message'), 'hello');
      expect(screen.getByTestId('question-counter')).toHaveTextContent('5 / 4,000');
      expect(screen.getByLabelText('Message')).toHaveAccessibleDescription('5 / 4,000');
    });

    it('counts characters the way the api does: an emoji is one, surrounding spaces are not counted', async () => {
      const user = userEvent.setup();
      render(<MessageInput onSubmit={vi.fn()} maxChars={10} />);
      await user.type(
        screen.getByLabelText('Message'),
        '  a' + String.fromCodePoint(0x1f600) + 'b  ',
      );
      expect(screen.getByTestId('question-counter')).toHaveTextContent('3 / 10');
    });

    it('does not send a question that is too long, by button or by Enter, and says so', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<MessageInput onSubmit={onSubmit} maxChars={5} />);
      const box = screen.getByLabelText('Message');
      await user.type(box, '123456');
      expect(screen.getByTestId('question-counter')).toHaveTextContent('6 / 5 — too long to send');
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
      expect(box).toHaveValue('123456'); // nothing is lost

      await user.keyboard('{Backspace}{Enter}');
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('12345');
    });

    it('sends a question of exactly the limit', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<MessageInput onSubmit={onSubmit} maxChars={5} />);
      await user.type(screen.getByLabelText('Message'), '12345{Enter}');
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('12345');
    });

    it('treats a huge paste as too long', async () => {
      const user = userEvent.setup();
      render(<MessageInput onSubmit={vi.fn()} maxChars={10} />);
      await user.click(screen.getByLabelText('Message'));
      await user.paste('x'.repeat(5000));
      expect(screen.getByTestId('question-counter')).toHaveTextContent('too long to send');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    it('shows no counter when there is no limit', () => {
      render(<MessageInput onSubmit={vi.fn()} />);
      expect(screen.queryByTestId('question-counter')).not.toBeInTheDocument();
    });
  });

  describe('keyboard focus while the box is disabled', () => {
    function Busy() {
      const [busy, setBusy] = useState(false);
      return (
        <>
          <MessageInput onSubmit={() => setBusy(true)} disabled={busy} />
          <button type="button" onClick={() => setBusy(false)}>
            finish
          </button>
        </>
      );
    }

    it('gives focus back when the box is enabled again, if the person was typing in it', async () => {
      const user = userEvent.setup();
      render(<Busy />);
      await user.type(screen.getByLabelText('Message'), 'q{Enter}');
      expect(screen.getByLabelText('Message')).toBeDisabled();
      // jsdom keeps focus on a disabled box; a browser drops it. Reproduce the drop:
      const stray = document.createElement('button');
      document.body.append(stray);
      stray.focus();
      stray.remove();
      expect(screen.getByLabelText('Message')).not.toHaveFocus();
      screen.getByRole('button', { name: 'finish' }).click();
      await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
      expect(screen.getByLabelText('Message')).toHaveFocus();
    });

    it('does not steal focus from somewhere else the person moved to', async () => {
      const user = userEvent.setup();
      render(<Busy />);
      await user.type(screen.getByLabelText('Message'), 'q{Enter}');
      const finish = screen.getByRole('button', { name: 'finish' });
      finish.focus(); // the person moved on while it was busy
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByLabelText('Message')).toBeEnabled());
      expect(screen.getByLabelText('Message')).not.toHaveFocus();
      expect(finish).toHaveFocus();
    });
  });

  it('announces "too long" to assistive technology, once, in a status region', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSubmit={vi.fn()} maxChars={3} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');
    await user.type(screen.getByLabelText('Message'), '1234');
    expect(status).toHaveTextContent('Too long to send');
    await user.keyboard('{Backspace}');
    expect(status).toHaveTextContent('');
  });
});
