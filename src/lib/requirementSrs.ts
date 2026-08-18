import { namesCodebaseLocation } from '@/core/shared/codebaseLocations';

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

// Repo locations and raw selectors are machine trace, not something a requirement's reader acts on.
// Detected by the shared matcher the Agent Console sanitizer uses, so both boundaries stay in step.
const namesInternals = (line: string): boolean => namesCodebaseLocation(line, { selectors: true });

// Clauses arrive written as whole sentences, so joining them raw yields "…is sent., then …". Drop a
// single trailing period before the connector; anything else the author wrote (?, !, "1.0.0") is kept.
const clause = (value: string): string => value.trim().replace(/(?<![.\d])\.$/, '');

// Render one Gherkin criterion as a single bullet, skipping any empty clause.
function formatAcceptanceCriterion(ac: RequirementAcceptanceCriterion): string {
  const parts: string[] = [];
  if (ac.given && ac.given.trim()) parts.push(`Given ${clause(ac.given)}`);
  if (ac.when && ac.when.trim()) parts.push(`when ${clause(ac.when)}`);
  if (ac.then && ac.then.trim()) parts.push(`then ${clause(ac.then)}`);
  if (!parts.length) return '';
  // The last clause ends the sentence — restore the period the join no longer supplies.
  return `- ${parts.join(', ')}.`;
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

      // A detail that only names a file or a selector carries nothing for the reader — drop the whole
      // line rather than editing the sentence around the token. The stored data keeps it for grounding.
      const detailItems = (requirement.details || []).filter(Boolean).filter((d) => !namesInternals(String(d))).map((detail) => `- ${detail}`);
      // Headed, because an unheaded bullet list straight after the criteria reads as one more criterion —
      // which is how "the exact endpoint path was not supplied" appeared to be a condition of the test.
      const details = detailItems.length ? ['**Details**', ...detailItems] : [];

      const cites = (requirement.sources || []).filter((s) => s && String(s).trim() && !namesInternals(String(s)));
      const sourceLine = cites.length ? [`*Source: ${cites.join(', ')}*`] : [];

      return [heading, requirement.statement, ...acBlock, ...details, ...sourceLine].join('\n\n');
    });
    return [`## ${moduleIndex + 1}. ${module.title}`, ...requirements].join('\n\n');
  });
  return ['# Software Requirements Specification (SRS)', SRS_INTRO, ...sections].join('\n\n');
}
