import { GitBranch } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={GitBranch} title="Git Agent" description="Change-impact: which suites a commit puts at risk." />
      <EmptyState icon={GitBranch} title="No changes scanned" hint="Connect a repo and ask the agent which tests are impacted by recent commits." />
    </PageBody>
  );
}
