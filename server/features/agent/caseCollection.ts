export function reviewedCasesForRun(run: any): any[] {
  if (Array.isArray(run?.all_generated_cases) && run.all_generated_cases.length) return run.all_generated_cases;
  const generated = [...(run?.messages || [])].reverse()
    .find((message: any) => message?.agent === 'TestGenerationAgent' && Array.isArray(message?.output?.test_cases))
    ?.output?.test_cases;
  return generated || run?.generated_cases || [];
}

export function syncReviewedCases(run: any, cases: any[]): void {
  run.generated_cases = cases;
  run.all_generated_cases = cases;
}
