import { Network } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={Network} title="Traceability" description="Requirement → case → run → evidence matrix." />
      <EmptyState icon={Network} title="Nothing to trace yet" hint="Generate requirements and cases, then runs — the matrix links them end to end." />
    </PageBody>
  );
}
