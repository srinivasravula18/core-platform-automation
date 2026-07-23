export function structureRequirementText(value: string): { description: string; businessRules: string[] } {
  const lines = String(value || '')
    .replace(/^Approved understanding\s*:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const firstSection = lines.findIndex((line) => /^\d+[.)]\s+\S/.test(line));
  if (firstSection < 0) {
    return { description: lines.filter(Boolean).join('\n'), businessRules: [] };
  }

  const description = lines.slice(0, firstSection).filter(Boolean).join('\n');
  const businessRules: string[] = [];
  let section = '';
  for (const line of lines.slice(firstSection)) {
    const heading = line.match(/^\d+[.)]\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      businessRules.push(section ? `${section}: ${bullet[1].trim()}` : bullet[1].trim());
      continue;
    }
    if (line && businessRules.length) businessRules[businessRules.length - 1] += ` ${line}`;
  }
  return { description, businessRules };
}
