import { createHash } from 'crypto';
import * as unzipper from 'unzipper';
import { uid, isPostgresEnabled } from '../../db/pool';
import { AutomationDatasets, AutomationDatasetRows } from '../../db/repository';
import { persistDataInBackground } from '../../shared/storage';
import { scopeStamp, type Scope } from '../../shared/scope';
import type { DatasetColumn, DatasetColumnKind, DatasetProviderType } from './types';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;

export interface IDataProvider {
  readonly type: DatasetProviderType;
  read(buffer: Buffer): Promise<unknown[][]>;
}

function csvRows(buffer: Buffer): unknown[][] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ',') { row.push(cell); cell = ''; continue; }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = ''; continue;
    }
    cell += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted value.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function xmlText(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function columnIndex(reference: string): number {
  return reference.split('').reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

async function xlsxRows(buffer: Buffer): Promise<unknown[][]> {
  if (buffer.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('XLSX file is not a valid Office workbook.');
  const archive = await unzipper.Open.buffer(buffer);
  const uncompressedBytes = archive.files.reduce((total, file) => total + Number((file as any).uncompressedSize || 0), 0);
  if (archive.files.length > 200 || uncompressedBytes > MAX_BYTES * 10) throw new Error('XLSX archive exceeds safe extraction limits.');
  const entry = (name: string) => archive.files.find((file) => file.path === name);
  const worksheet = archive.files.filter((file) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.path)).sort((a, b) => a.path.localeCompare(b.path))[0];
  if (!worksheet) throw new Error('XLSX file contains no worksheets.');
  const sharedEntry = entry('xl/sharedStrings.xml');
  const shared = sharedEntry ? [...(await sharedEntry.buffer()).toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1])) : [];
  const xml = (await worksheet.buffer()).toString('utf8');
  const rows: unknown[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = cellMatch[1].match(/\br="([A-Z]+)\d+"/i)?.[1];
      if (!reference) continue;
      const index = columnIndex(reference.toUpperCase());
      const type = cellMatch[1].match(/\bt="([^"]+)"/)?.[1];
      const body = cellMatch[2];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      row[index] = type === 's' ? shared[Number(raw)] || '' : xmlText(raw);
    }
    rows.push(row);
  }
  return rows;
}

const providers: Record<DatasetProviderType, IDataProvider> = {
  csv: { type: 'csv', async read(buffer) { return csvRows(buffer); } },
  xlsx: {
    type: 'xlsx',
    read: xlsxRows,
  },
};

function cell(value: unknown): string {
  return value == null ? '' : String(value);
}

function inferKind(values: string[]): DatasetColumnKind {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (!nonEmpty.length) return 'text';
  if (nonEmpty.every((value) => /^(true|false)$/i.test(value))) return 'boolean';
  if (nonEmpty.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return 'email';
  if (nonEmpty.every((value) => /^\+?[\d() .-]{7,}$/.test(value))) return 'phone';
  if (nonEmpty.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime()))) return 'date';
  if (nonEmpty.every((value) => /^[-+]?\d+(?:\.\d+)?$/.test(value))) return 'number';
  return 'text';
}

function normalize(matrix: unknown[][]): { columns: DatasetColumn[]; rows: Array<{ rowNumber: number; values: Record<string, string | null> }> } {
  const [header = [], ...sourceRows] = matrix;
  const names = (header as unknown[]).map(cell).map((name) => name.trim());
  if (!names.length || names.every((name) => !name)) throw new Error('Dataset must have a header row.');
  if (names.some((name) => !name)) throw new Error('Dataset headers cannot be empty.');
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`Duplicate column header: ${duplicates[0]}.`);
  const compact = sourceRows.filter((row) => (row as unknown[]).some((value) => cell(value).trim()));
  if (compact.length > MAX_ROWS) throw new Error(`Dataset exceeds the ${MAX_ROWS.toLocaleString()} row limit.`);
  const columns = names.map((name, ordinal) => ({ id: `col_${ordinal + 1}`, name, ordinal, kind: inferKind(compact.map((row) => cell((row as unknown[])[ordinal]))), nullable: compact.some((row) => !cell((row as unknown[])[ordinal]).trim()) }));
  return {
    columns,
    rows: compact.map((row, index) => ({
      rowNumber: index + 2,
      values: Object.fromEntries(columns.map((column) => [column.id, cell((row as unknown[])[column.ordinal]) || null])),
    })),
  };
}

function persist(reason: string) { if (!isPostgresEnabled()) persistDataInBackground(reason); }

export async function importDataset(input: { provider: DatasetProviderType; filename: string; name?: string; buffer: Buffer }, scope: Scope) {
  if (!Buffer.isBuffer(input.buffer) || !input.buffer.length) throw new Error('Dataset file is empty.');
  if (input.buffer.length > MAX_BYTES) throw new Error(`Dataset exceeds the ${MAX_BYTES / 1024 / 1024} MB upload limit.`);
  const parsed = normalize(await providers[input.provider].read(input.buffer));
  const now = new Date().toISOString();
  const dataset = await AutomationDatasets.upsert({
    id: uid('DATASET'), name: input.name?.trim() || input.filename.replace(/\.[^.]+$/, '') || 'Untitled dataset', provider: input.provider,
    sourceFilename: input.filename, sourceHash: createHash('sha256').update(input.buffer).digest('hex'), columns: parsed.columns,
    rowCount: parsed.rows.length, status: 'ready', createdAt: now, ...scopeStamp(scope),
  });
  await AutomationDatasetRows.replace(dataset.id, parsed.rows.map((row) => ({ id: uid('DROW'), ...row })));
  persist('automation dataset imported');
  return dataset;
}

export async function listDatasets() { return AutomationDatasets.list(); }
export async function getDataset(id: string) { return AutomationDatasets.get(id); }
export async function datasetPage(id: string, offset?: number, limit?: number) { return AutomationDatasetRows.page(id, offset, limit); }
