export type RequirementSrsModule = {
  title: string;
  requirements: Array<{
    title: string;
    statement: string;
    details?: string[];
  }>;
};

export const SRS_INTRO = 'Here is a structured Software Requirements Specification (SRS) formatted into distinct functional modules based on your provided details:';

export function formatRequirementSrs(modules: RequirementSrsModule[]): string {
  const sections = modules.map((module, moduleIndex) => {
    const requirements = module.requirements.map((requirement, requirementIndex) => {
      const heading = `### ${moduleIndex + 1}.${requirementIndex + 1} ${requirement.title}`;
      const details = (requirement.details || []).filter(Boolean).map((detail) => `- ${detail}`);
      return [heading, requirement.statement, ...details].join('\n\n');
    });
    return [`## ${moduleIndex + 1}. ${module.title}`, ...requirements].join('\n\n');
  });
  return ['# Software Requirements Specification (SRS)', SRS_INTRO, ...sections].join('\n\n');
}
