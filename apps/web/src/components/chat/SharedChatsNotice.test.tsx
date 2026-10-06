// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedChatsNotice, SHARED_CHATS_NOTICE } from './SharedChatsNotice';

describe('<SharedChatsNotice />', () => {
  afterEach(cleanup);

  it('says chats are visible to everyone and that personal or confidential data must not be entered', () => {
    render(<SharedChatsNotice />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/visible to everyone using Team Assistant/);
    expect(note).toHaveTextContent(/Do not enter personal data/);
    expect(note).toHaveTextContent(/confidential information/);
    expect(note).toHaveTextContent(SHARED_CHATS_NOTICE);
  });

  it('is the wording proposed in the threat model, word for word', () => {
    expect(SHARED_CHATS_NOTICE).toBe(
      'Conversations are visible to everyone using Team Assistant and are kept. Do not enter personal data, passwords, keys or other confidential information. Answers can be wrong; check the cited document.',
    );
  });

  it('stays in the normal page flow, so it cannot cover the thread or the input', () => {
    render(<SharedChatsNotice />);
    const classes = screen.getByRole('note').className.split(/\s+/);
    for (const overlay of ['fixed', 'absolute', 'sticky']) {
      expect(classes.filter((c) => c === overlay || c.endsWith(`:${overlay}`))).toEqual([]);
    }
  });
});
