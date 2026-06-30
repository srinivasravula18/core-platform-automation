import { AgentConsole } from "@/components/agent-console";

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <AgentConsole initialQuery={q} />;
}
