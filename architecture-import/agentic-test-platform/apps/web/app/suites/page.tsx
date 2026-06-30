import { Layers } from "lucide-react";
import { PageBody, PageHeader, EmptyState } from "@/components/ui/page";

export default function Page() {
  return (
    <PageBody>
      <PageHeader icon={Layers} title="Test Suites" description="Sanity, regression, BVT and API suites grouping your cases." />
      <EmptyState icon={Layers} title="No suites yet" hint="Suites are formed from the cases the agent generates (suite tags on each case)." />
    </PageBody>
  );
}
