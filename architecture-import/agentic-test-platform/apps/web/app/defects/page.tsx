import { Bug } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={Bug} title="Defects" description="Defects raised automatically from failing cases." />
      <EmptyState icon={Bug} title="No defects" hint="When a run fails, the agent files a defect linked to the failing case and run." />
    </PageBody>
  );
}
