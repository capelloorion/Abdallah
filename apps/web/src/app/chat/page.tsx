import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

/**
 * The chat page: the conversation list and the selected conversation. It talks only to the
 * same-origin BFF routes under `/api/v1/conversations`; with `MOCK_UPSTREAM=true` those serve the
 * fixtures in `src/mocks/conversations.ts`. Kept thin on purpose: state lives in `ChatWorkspace`
 * and `src/lib/conversations-client.ts` (pages are under the manual Playwright smoke).
 */
export default function ChatPage() {
  return (
    <main className="px-4 py-8">
      <ChatWorkspace />
      <p className="mx-auto mt-6 max-w-6xl text-xs text-neutral-500">
        Set <code>MOCK_UPSTREAM=true</code> in <code>apps/web/.env.local</code> to try this page
        before the api is running.
      </p>
    </main>
  );
}
