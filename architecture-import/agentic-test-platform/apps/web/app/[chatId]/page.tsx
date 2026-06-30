import { AgentConsole } from "@/components/agent-console";

// Deep link to a specific conversation: localhost:3000/{chatId}
// (Static routes like /dashboard, /cases take precedence; chat ids are UUIDs.)
export default async function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <AgentConsole initialChatId={chatId} />;
}
