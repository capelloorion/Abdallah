/**
 * The notice that chats are shared. Until sign-in exists (ADR-0014) every conversation is visible
 * to everyone using the app, so people are told not to enter personal or confidential data.
 *
 * The wording is the one PROPOSED in the shared-conversations threat model (section 9). It is the
 * team's to approve: change it here, in one place, and in the test beside it.
 *
 * It sits in the normal page flow above the chat (never fixed, sticky or absolute), so it cannot
 * cover the thread or the input at any width.
 */
export const SHARED_CHATS_NOTICE =
  'Conversations are visible to everyone using Team Assistant and are kept. Do not enter personal data, passwords, keys or other confidential information. Answers can be wrong; check the cited document.';

export function SharedChatsNotice() {
  return (
    <p
      role="note"
      className="mx-auto mb-4 max-w-6xl rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      {SHARED_CHATS_NOTICE}
    </p>
  );
}
