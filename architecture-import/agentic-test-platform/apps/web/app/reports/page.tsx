import { BarChart3 } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={BarChart3} title="Reports" description="Run reports and coverage rollups." />
      <EmptyState icon={BarChart3} title="No reports yet" hint="Reports are produced after a run completes." />
    </PageBody>
  );
}
