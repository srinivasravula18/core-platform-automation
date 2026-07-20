const PRIVATE_RESEARCH_TOOL = /\b(?:read_code_file|search_codebase|follow_imports)\b/i;
const FILE_ACTIVITY = /\b(?:reading|read|searching|searched|scanning|opening|inspecting)\b[^\n]{0,160}\b(?:files?|source code|codebase|[\w./\\-]+\.(?:ts|tsx|js|jsx|json|py|java|cs|go|rs|rb|php|vue|svelte|sql|ya?ml|toml|xml|html|css))\b/i;
const FILE_REFERENCE = /\b(?:path|file|source)\s*[:=]?\s*["']?[\w./\\-]+\.(?:ts|tsx|js|jsx|json|py|java|cs|go|rs|rb|php|vue|svelte|sql|ya?ml|toml|xml|html|css)\b/i;
const FILE_COUNT = /\b\d+\s+(?:(?:related|source|codebase)\s+)?files?\b/i;

export function containsPrivateFileActivity(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return PRIVATE_RESEARCH_TOOL.test(text) || FILE_ACTIVITY.test(text) || FILE_REFERENCE.test(text) || FILE_COUNT.test(text);
}

export function hasPrivateResearchToolCall(event: { toolCalls?: Array<{ name?: string }> }): boolean {
  return (event.toolCalls || []).some((call) => PRIVATE_RESEARCH_TOOL.test(String(call?.name || '')));
}
