export type RequirementAcceptanceCriterion = { given?: string; when?: string; then?: string };

export type RequirementSrsModule = {
  title: string;
  requirements: Array<{
    title: string;
    statement: string;
    priority?: string;
    category?: string;
    acceptanceCriteria?: RequirementAcceptanceCriterion[];
    sources?: string[];
    details?: string[];
  }>;
};

export const SRS_INTRO = 'Here is a structured Software Requirements Specification (SRS) formatted into distinct functional modules based on your provided details:';

export function formatBusinessRulesMarkdown(rules: string[]): string {
  return ['## Business Rules', ...rules.filter(Boolean).map((rule) => `- ${rule}`)].join('\n\n');
}

// Render one Gherkin criterion as a single bullet, skipping any empty clause.
function formatAcceptanceCriterion(ac: RequirementAcceptanceCriterion): string {
  const parts: string[] = [];
  if (ac.given && ac.given.trim()) parts.push(`Given ${ac.given.trim()}`);
  if (ac.when && ac.when.trim()) parts.push(`when ${ac.when.trim()}`);
  if (ac.then && ac.then.trim()) parts.push(`then ${ac.then.trim()}`);
  return parts.length ? `- ${parts.join(', ')}` : '';
}

export function formatRequirementSrs(modules: RequirementSrsModule[]): string {
  const sections = modules.map((module, moduleIndex) => {
    const requirements = module.requirements.map((requirement, requirementIndex) => {
      // MoSCoW tag and NFR category are appended only when present, so requirements without
      // them render exactly as before (keeps existing consumers/tests stable).
      const category = requirement.category && requirement.category.trim() ? `[${requirement.category.trim()}] ` : '';
      const priority = requirement.priority && requirement.priority.trim() ? ` *(${requirement.priority.trim()})*` : '';
      const heading = `### ${moduleIndex + 1}.${requirementIndex + 1} ${category}${requirement.title}${priority}`;

      const acItems = (requirement.acceptanceCriteria || []).map(formatAcceptanceCriterion).filter(Boolean);
      const acBlock = acItems.length ? ['**Acceptance criteria**', ...acItems] : [];

      const details = (requirement.details || []).filter(Boolean).map((detail) => `- ${detail}`);

      const cites = (requirement.sources || []).filter((s) => s && String(s).trim());
      const sourceLine = cites.length ? [`*Source: ${cites.join(', ')}*`] : [];

      return [heading, requirement.statement, ...acBlock, ...details, ...sourceLine].join('\n\n');
    });
    return [`## ${moduleIndex + 1}. ${module.title}`, ...requirements].join('\n\n');
  });
  return ['# Software Requirements Specification (SRS)', SRS_INTRO, ...sections].join('\n\n');
}
