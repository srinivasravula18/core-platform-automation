import { FileText } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={FileText} title="Requirements" description="Requirements + RTM derived from the platform metadata." />
      <EmptyState icon={FileText} title="No requirements yet" hint="Ask the agent to analyze an object — it derives requirements from fields, validation rules and permissions." />
    </PageBody>
  );
}
