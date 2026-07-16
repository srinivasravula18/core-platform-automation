/**
 * Visual-regression baseline (bug-investigation framework, Phase 7; flag `VISUAL_REGRESSION`) — REPORT-ONLY.
 * Every run's per-step screenshots (MissionRunner act() evidence) are compared against a stored baseline:
 *   - first sighting of a case-step (from a PASSING test) SEEDS the baseline — never a finding
 *   - dimension change (PNG header parse — no image deps) → 'dimension-change' finding
 *   - large byte-level delta (length + sampled-byte mismatch) → 'content-change' finding
 * Findings are observations for the analyst/defect reports; they NEVER fail a run. Deterministic, no deps.
 */
import path from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import type { TestResultLike } from '../workflow/defectReporter';

/** Flag reader (lazy, per the dotenv load-order convention). */
export function isVisualRegressionEnabled(): boolean {
  return ['1', 'true'].includes(String(process.env.VISUAL_REGRESSION || '').toLowerCase());
}

export interface VisualFinding {
  caseTitle: string;
  step: number;
  kind: 'dimension-change' | 'content-change';
  message: string;
  confidence: number;
  baselinePath: string;
  currentPath: string;
}

export interface DiffRunStepsResult {
  findings: VisualFinding[];
  seeded: number;
  compared: number;
}

const DEFAULT_BASELINE_ROOT = () => path.resolve(process.cwd(), 'evidence', 'baselines');

/** Stable per-case directory name — title-derived so reruns of the same case hit the same baseline. */
export function caseSignature(title: string): string {
  return createHash('sha1').update(String(title || '')).digest('hex').slice(0, 12);
}

/** PNG width/height from the IHDR header (bytes 16..23); null for non-PNG buffers. */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Deterministic dimension + byte-fallback comparison. Null = no notable difference. */
export function diffImages(baseline: Buffer, current: Buffer): { kind: VisualFinding['kind']; message: string; confidence: number } | null {
  const bs = readPngSize(baseline);
  const cs = readPngSize(current);
  if (bs && cs && (bs.width !== cs.width || bs.height !== cs.height)) {
    return {
      kind: 'dimension-change',
      message: `Screenshot dimensions changed from ${bs.width}x${bs.height} to ${cs.width}x${cs.height} — layout shift, clipped region, or viewport change.`,
      confidence: 0.85,
    };
  }
  // Byte fallback: PNG compression makes this noisy, so thresholds are deliberately generous (report-only).
  const lenDelta = Math.abs(baseline.length - current.length) / Math.max(baseline.length, 1);
  const n = Math.min(baseline.length, current.length);
  const stride = Math.max(1, Math.floor(n / 2048));
  let mismatches = 0;
  let samples = 0;
  for (let i = 0; i < n; i += stride) {
    samples += 1;
    if (baseline[i] !== current[i]) mismatches += 1;
  }
  const mismatchRatio = samples ? mismatches / samples : 0;
  if (lenDelta > 0.05 || mismatchRatio > 0.3) {
    return {
      kind: 'content-change',
      message: `Screenshot content diverged from the baseline (${Math.round(lenDelta * 100)}% size delta, ${Math.round(mismatchRatio * 100)}% sampled-byte mismatch).`,
      confidence: 0.5,
    };
  }
  return null;
}

/**
 * Compare a run's per-step screenshots against the baseline store; seed missing baselines from PASSING
 * tests. Report-only and best-effort: unreadable files are skipped, never thrown.
 */
export async function diffRunSteps(input: { tests: TestResultLike[]; baselineRoot?: string }): Promise<DiffRunStepsResult> {
  const out: DiffRunStepsResult = { findings: [], seeded: 0, compared: 0 };
  const root = input.baselineRoot || DEFAULT_BASELINE_ROOT();
  for (const t of input.tests ?? []) {
    const shots = t.stepScreenshotPaths ?? [];
    if (!shots.length) continue;
    const dir = path.join(root, caseSignature(t.title));
    for (let step = 0; step < shots.length; step += 1) {
      const currentPath = shots[step];
      const baselinePath = path.join(dir, `step-${step + 1}.png`);
      try {
        const current = await fs.readFile(currentPath);
        const baseline = await fs.readFile(baselinePath).catch(() => null);
        if (!baseline) {
          // Seed ONLY from passing tests — a failure's frames are not a known-good reference.
          if (t.status === 'passed') {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(baselinePath, current);
            out.seeded += 1;
          }
          continue;
        }
        out.compared += 1;
        const diff = diffImages(baseline, current);
        if (diff) {
          out.findings.push({
            caseTitle: t.title,
            step: step + 1,
            kind: diff.kind,
            message: diff.message,
            confidence: diff.confidence,
            baselinePath,
            currentPath,
          });
        }
      } catch { /* unreadable frame — skip, report-only */ }
    }
  }
  return out;
}
