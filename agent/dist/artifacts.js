/**
 * Walk a finished run directory and classify the artifacts worth uploading.
 *
 * Playwright writes traces/videos/screenshots under test-results/, plus the JSON/JUnit reporter files
 * and an HTML report folder at the run root. We map each to a kind the cloud understands.
 */
import fs from 'fs';
import path from 'path';
function classify(file) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.zip'))
        return 'trace';
    if (lower.endsWith('.webm') || lower.endsWith('.mp4'))
        return 'video';
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
        return 'screenshot';
    if (lower.endsWith('.xml'))
        return 'junit';
    if (lower.endsWith('.html'))
        return 'html';
    if (lower.endsWith('.json') || lower.endsWith('.log') || lower.endsWith('.txt'))
        return 'log';
    return 'other';
}
function walk(dir, acc) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory())
            walk(full, acc);
        else
            acc.push(full);
    }
}
export function collectArtifacts(runDir) {
    const files = [];
    walk(path.join(runDir, 'test-results'), files);
    for (const f of ['results.json', 'results.xml']) {
        const p = path.join(runDir, f);
        if (fs.existsSync(p))
            files.push(p);
    }
    // The HTML report's single-file index is the useful summary; asset chunks are skipped to keep uploads lean.
    const htmlIndex = path.join(runDir, 'playwright-report', 'index.html');
    if (fs.existsSync(htmlIndex))
        files.push(htmlIndex);
    return files.map((p) => ({ kind: classify(p), path: p, filename: path.basename(p) }));
}
//# sourceMappingURL=artifacts.js.map