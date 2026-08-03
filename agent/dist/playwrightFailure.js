const ANSI = /\u001b\[[0-9;]*m/g;
function suitesOf(suites) {
    return suites.flatMap((suite) => [suite, ...suitesOf(suite?.suites || [])]);
}
function failedStep(steps = []) {
    for (const step of steps) {
        const nested = failedStep(step?.steps || []);
        if (nested)
            return nested;
        if (step?.error)
            return step;
    }
    return null;
}
/** Turn Playwright's JSON failure into a concise, user-facing script location. */
export function playwrightFailure(report, script) {
    for (const suite of suitesOf(report?.suites || [])) {
        for (const spec of suite?.specs || []) {
            for (const test of spec?.tests || []) {
                for (const result of test?.results || []) {
                    if (!['failed', 'timedOut', 'interrupted'].includes(String(result?.status)))
                        continue;
                    const error = result.error || result.errors?.[0] || {};
                    const stack = String(error.stack || error.message || '').replace(ANSI, '');
                    const stackLocation = /recording\.spec\.ts:(\d+):(\d+)/.exec(stack);
                    const location = error.location || result.errorLocation || (stackLocation ? { line: Number(stackLocation[1]), column: Number(stackLocation[2]) } : null);
                    const line = Number(location?.line || 0);
                    const sourceLines = String(script || '').split(/\r?\n/);
                    const source = line > 0 ? String(sourceLines[line - 1] || '').trim() : '';
                    const stepNumber = line > 0
                        ? sourceLines.slice(0, line).filter((value) => /^\s*await\s+(?!test\.step\b)/.test(value)).length
                        : 0;
                    const step = failedStep(result.steps);
                    const where = [
                        line ? `script line ${line}${location?.column ? `:${location.column}` : ''}` : '',
                        stepNumber ? `recorded step ${stepNumber}` : (step?.title ? `step "${step.title}"` : ''),
                    ].filter(Boolean).join(', ');
                    const message = String(error.message || stack.split('\n')[0] || 'Playwright reported a failure.').replace(ANSI, '').trim();
                    return [`Execution failed${where ? ` at ${where}` : ''}.`, source ? `Code: ${source}` : '', `Error: ${message}`].filter(Boolean).join('\n');
                }
            }
        }
    }
    return '';
}
//# sourceMappingURL=playwrightFailure.js.map