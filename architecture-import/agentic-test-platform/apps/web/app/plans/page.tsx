import { ClipboardList } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={ClipboardList} title="Test Plans" description="IEEE-829 test plans the agent drafts for an app or object." />
      <EmptyState icon={ClipboardList} title="No test plans yet" hint="Ask the Agent Console to plan testing for an app — the plan will be saved here." />
    </PageBody>
  );
}
