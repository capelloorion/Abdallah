// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationDrawer } from './ConversationDrawer';

/** A controlled drawer with two buttons inside, the way ChatWorkspace uses it. */
function Harness({ onPick = vi.fn() }: { onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">before</button>
      <ConversationDrawer
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        id="drawer"
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onPick();
          }}
        >
          pick a chat
        </button>
        <button type="button">+ New chat</button>
      </ConversationDrawer>
      <button type="button">after</button>
    </>
  );
}

const toggle = () => screen.getByRole('button', { name: 'Chats' });

describe('<ConversationDrawer />', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts closed: the toggle reports collapsed and points at the panel', () => {
    render(<Harness />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAttribute('aria-controls', 'drawer');
    expect(document.getElementById('drawer')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-backdrop')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('opens from the toggle: expanded, a dialog, and focus moves inside', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Chats' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('closes on Esc and hands focus back to the toggle', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    await user.keyboard('{Escape}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();
  });

  it('closes from the Close button and from the backdrop, each returning focus to the toggle', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();

    await user.click(toggle());
    await user.click(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();
  });

  it('the toggle closes it again when it is pressed while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    toggle().focus(); // the backdrop covers it for a pointer; a keyboard or screen reader can still press it
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Tab inside the open drawer, in both directions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: '+ New chat' });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus(); // wrapped from the first to the last
    await user.tab();
    expect(close).toHaveFocus(); // and back
    await user.tab();
    await user.tab();
    await user.tab();
    expect(close).toHaveFocus(); // never reaches "after"
  });

  it('ignores Esc and Tab while closed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(toggle()).toHaveFocus(); // plain page order: not trapped, not redirected
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esc still closes it when focus has fallen to the page body', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    (document.activeElement as HTMLElement).blur();
    // jsdom keeps focus on a focused element it was asked to blur? make sure it is really on the body
    const stray = document.createElement('button');
    document.body.append(stray);
    stray.focus();
    stray.remove();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toggle()).toHaveFocus();
  });

  it('Tab brings focus back inside when it is outside the open drawer', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    const stray = document.createElement('button');
    document.body.append(stray);
    stray.focus();
    stray.remove();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    stray.remove();
    const outside = screen.getByRole('button', { name: 'after' });
    outside.focus(); // focus somewhere on the page behind the drawer
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '+ New chat' })).toHaveFocus();
  });

  it('puts focus on the toggle when an action closes it without moving focus anywhere', async () => {
    const user = userEvent.setup();
    // The action closes the drawer and, like a browser hiding the focused button, leaves focus on the body.
    const dropFocus = () => {
      const stray = document.createElement('button');
      document.body.append(stray);
      stray.focus();
      stray.remove();
    };
    render(<Harness onPick={dropFocus} />);
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'pick a chat' }));
    await vi.waitFor(() => expect(toggle()).toHaveFocus());
  });

  it('leaves focus where the action sent it', async () => {
    const user = userEvent.setup();
    function Sends() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <textarea aria-label="Message" />
          <ConversationDrawer
            open={open}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
            id="d2"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                document.querySelector<HTMLTextAreaElement>('textarea')?.focus();
              }}
            >
              go
            </button>
          </ConversationDrawer>
        </>
      );
    }
    render(<Sends />);
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'go' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText('Message')).toHaveFocus();
    expect(toggle()).not.toHaveFocus();
  });

  it('closes when the window grows to two columns', async () => {
    let listener: (() => void) | undefined;
    const wide = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => {
        listener = fn;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', () => wide);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    wide.matches = true;
    act(() => listener?.());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(wide.removeEventListener).toHaveBeenCalled();
  });

  it('keeps the two-column layout classes: shown from 768 px, toggle hidden there', () => {
    render(<Harness />);
    const panel = document.getElementById('drawer')!;
    expect(panel.className).toContain('md:flex');
    expect(panel.className).toContain('hidden'); // collapsed below 768 px until opened
    expect(toggle().parentElement?.className).toContain('md:hidden');
  });
});
