/**
 * Excel template generation for data-driven runs.
 *
 * The template is built FROM a recording, so its "Data" sheet headers are exactly the recording's
 * editable field labels — re-uploading a filled template lines columns up 1:1 with fields, which is
 * what makes Auto-map trivial. A second "Guide" sheet carries per-field intent/tips and is never
 * parsed by the importer (it only reads the first worksheet). Written with inline strings so it
 * round-trips through this module's own unzipper-based xlsx reader.
 */

import * as archiverModule from 'archiver';
import type { RecordingFieldKind } from './types';

// archiver ships as a CommonJS `export =` callable; normalize across ESM/CJS interop.
const archiver: (...args: any[]) => any = (archiverModule as any).default ?? (archiverModule as any);

export type FieldIntent = 'fixed' | 'unique' | 'reference';
export interface GuideRow { label: string; type: string; intent: FieldIntent; required: string; example: string; tip: string }

/** A realistic sample value per field kind, so the template shows the user WHAT to type. */
export function sampleFor(kind: RecordingFieldKind | undefined, label: string): string {
  switch (kind) {
    case 'email': return 'jane.doe@example.com';
    case 'number': return '42';
    case 'phone': return '+1 555 0100';
    case 'date': return '1990-04-09';
    case 'boolean': return 'true';
    case 'select': return '(one of the field’s options)';
    default: return `Sample ${label}`.trim();
  }
}

/** Recorded field kind/label → a sensible default data intent for the Guide sheet. */
export function inferIntent(label: string, kind?: RecordingFieldKind): FieldIntent {
  const lower = (label || '').toLowerCase();
  if (kind === 'email' || /e-?mail/.test(lower)) return 'unique';
  if (/user\s*name|login/.test(lower)) return 'unique';
  return 'fixed';
}

export function intentTip(intent: FieldIntent): string {
  if (intent === 'unique') return 'Leave blank to auto-generate a fresh value each run.';
  if (intent === 'reference') return 'Must already exist in the app.';
  return 'Same value every run.';
}

function esc(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colRef(index: number): string {
  let n = index; let ref = '';
  do { ref = String.fromCharCode(65 + (n % 26)) + ref; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return ref;
}

function row(rowNumber: number, cells: string[]): string {
  const body = cells.map((value, index) => `<c r="${colRef(index)}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`).join('');
  return `<row r="${rowNumber}">${body}</row>`;
}

function sheet(rows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Guide" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

function zipToBuffer(files: Array<{ name: string; content: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk) => chunks.push(chunk as Buffer));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const file of files) archive.append(file.content, { name: file.name });
    void archive.finalize();
  });
}

/** Build a two-sheet .xlsx: "Data" (field-name headers only) + "Guide" (intent + tips). */
export function buildTemplateWorkbook(fields: string[], guide: GuideRow[]): Promise<Buffer> {
  const dataSheet = sheet([row(1, fields)]);
  const guideSheet = sheet([
    row(1, ['Field', 'Type', 'Intent', 'Required', 'Example', 'Tip']),
    ...guide.map((item, index) => row(index + 2, [item.label, item.type, item.intent, item.required, item.example, item.tip])),
  ]);
  return zipToBuffer([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'xl/workbook.xml', content: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', content: dataSheet },
    { name: 'xl/worksheets/sheet2.xml', content: guideSheet },
  ]);
}
