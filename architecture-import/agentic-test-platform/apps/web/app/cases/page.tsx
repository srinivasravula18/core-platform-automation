import { ListChecks, FileCode2 } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/page";
import { CasesTable } from "@/components/cases-table";
import { ArtifactList } from "@/components/artifact-list";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={ListChecks} title="Test Cases" description="ISTQB cases the agent generated, grounded in your repo metadata." />
      <CasesTable />
      <div className="mt-8 mb-2 flex items-center gap-2 text-sm font-medium"><FileCode2 className="h-4 w-4 text-muted-foreground" /> Generated scripts</div>
      <ArtifactList kinds={["script"]} emptyTitle="No scripts yet" emptyHint="Ask the agent to write a grounded Playwright script." />
    </PageBody>
  );
}
