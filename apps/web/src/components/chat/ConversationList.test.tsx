// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList, type ConversationItem } from './ConversationList';

const NOW = new Date('2026-10-06T12:00:00Z');
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ITEMS: ConversationItem[] = [
  { id: ID_A, title: 'Which port?', updated_at: '2026-10-06T11:55:00Z' },
  { id: ID_B, title: 'Deploy steps', updated_at: '2026-10-05T12:00:00Z' },
];

function setup(props: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  const onSelect = vi.fn();
  const onNewChat = vi.fn();
  render(
    <ConversationList
      items={ITEMS}
      onSelect={onSelect}
      onNewChat={onNewChat}
      now={NOW}
      {...props}
    />,
  );
  return { onSelect, onNewChat, user: userEvent.setup() };
}

describe('<ConversationList />', () => {
  afterEach(cleanup);

  it('renders a row per conversation with its title and relative time', () => {
    setup();
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Which port?');
    expect(rows[0]).toHaveTextContent('5 minutes ago');
    expect(rows[1]).toHaveTextContent('Deploy steps');
    expect(rows[1]).toHaveTextContent('yesterday');
  });

  it('shows the empty state, and still offers + New chat', () => {
    const { onNewChat } = setup({ items: [] });
    expect(screen.getByTestId('conversations-empty')).toHaveTextContent('No chats yet');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    screen.getByRole('button', { name: '+ New chat' }).click();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('marks only the selected row with aria-current', () => {
    setup({ selectedId: ID_B });
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows[0]).not.toHaveAttribute('aria-current');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
  });

  it('marks nothing when no row is selected', () => {
    setup();
    expect(document.querySelector('[aria-current]')).toBeNull();
  });

  it('calls onSelect with the id of the clicked row', async () => {
    const { onSelect, user } = setup();
    await user.click(screen.getByRole('button', { name: /Deploy steps/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ID_B);
  });

  it('is operable from the keyboard', async () => {
    const { onSelect, onNewChat, user } = setup();
    await user.tab();
    expect(screen.getByRole('button', { name: '+ New chat' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onNewChat).toHaveBeenCalledTimes(1);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ID_A);
    await user.tab();
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith(ID_B);
  });

  it('disables every button while disabled', async () => {
    const { onSelect, onNewChat, user } = setup({ disabled: true });
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Which port/ }));
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('renders a hostile title as inert text', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    setup({ items: [{ id: ID_A, title: evil, updated_at: '2026-10-06T11:55:00Z' }] });
    const row = within(screen.getByRole('list')).getByRole('button');
    expect(row).toHaveTextContent(evil);
    expect(row.querySelector('img, script, a')).toBeNull();
  });

  it('treats a title of invisible characters as empty', () => {
    const blank = [0x200b, 0x200b, 0x2060, 0x2800, 0x3164, 0xfeff]
      .map((c) => String.fromCodePoint(c))
      .join('');
    setup({ items: [{ id: ID_A, title: blank, updated_at: '2026-10-06T11:55:00Z' }] });
    expect(within(screen.getByRole('list')).getByRole('button')).toHaveTextContent('Untitled chat');
  });

  it('offers the full title on hover, since the row clips it', () => {
    const long = 'Quarterly deployment checklist for the shared platform team '.repeat(3).trim();
    setup({ items: [{ id: ID_A, title: long, updated_at: '2026-10-06T11:55:00Z' }] });
    expect(screen.getByTitle(long)).toBeInTheDocument();
  });

  it('falls back to a name for an empty title and omits an unreadable time', () => {
    setup({ items: [{ id: ID_A, title: '   ', updated_at: 'garbage' }] });
    const row = within(screen.getByRole('list')).getByRole('button');
    expect(row).toHaveTextContent('Untitled chat');
    expect(row).not.toHaveTextContent(/NaN|Invalid/);
    expect(row.querySelectorAll('span')).toHaveLength(0);
  });
});
