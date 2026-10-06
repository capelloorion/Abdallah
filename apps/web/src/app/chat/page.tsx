import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { SharedChatsNotice } from '@/components/chat/SharedChatsNotice';

/**
 * The chat page: the shared-chats notice, then the conversation list and the selected
 * conversation. It talks only to the same-origin BFF routes under `/api/v1/conversations`. Kept
 * thin on purpose: state lives in `ChatWorkspace` and `src/lib/conversations-client.ts` (pages are
 * under the manual Playwright smoke).
 */
export default function ChatPage() {
  return (
    <main className="px-4 py-8">
      <SharedChatsNotice />
      <ChatWorkspace />
    </main>
  );
}
