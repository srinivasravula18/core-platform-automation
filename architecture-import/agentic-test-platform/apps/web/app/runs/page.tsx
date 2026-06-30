import { PlayCircle } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/page";
import { RunsTable } from "@/components/runs-table";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={PlayCircle} title="Test Runs" description="Suite executions with pass/fail and grounding accuracy." />
      <RunsTable />
    </PageBody>
  );
}
