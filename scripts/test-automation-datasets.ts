import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

for (const key of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT']) delete process.env[key];
process.env.DISABLE_POSTGRES = '1';
const scratch = path.resolve(process.cwd(), '.testflow-pw', 'scratch', 'automation-datasets-test');
fs.mkdirSync(scratch, { recursive: true });
process.chdir(scratch);

const scope = { projectId: 'p1', appId: 'a1', userId: 'u1', role: '' } as any;

async function workbookBuffer(): Promise<Buffer> {
  const archiver = (await import('archiver') as unknown as { default: any }).default;
  const zip = archiver('zip');
  const chunks: Buffer[] = [];
  zip.on('data', (chunk: Buffer) => chunks.push(chunk));
  zip.append('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>', { name: '[Content_Types].xml' });
  zip.append('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Alice</t></is></c><c r="B2"><v>10</v></c></row></sheetData></worksheet>', { name: 'xl/worksheets/sheet1.xml' });
  await zip.finalize();
  return Buffer.concat(chunks);
}

async function main() {
  const datasets = await import('../server/features/automation/datasetService');
  const { db } = await import('../server/shared/storage');
  db.automationDatasets = []; db.automationDatasetRows = [];

  const csv = Buffer.from('Email,Phone,Active,Note\r\nalice@example.com,+1 555 0100,true,"hello, world"\r\nbob@example.com,+1 555 0101,false,\r\n');
  const imported = await datasets.importDataset({ provider: 'csv', filename: 'customers.csv', buffer: csv }, scope);
  assert.strictEqual(imported.rowCount, 2);
  assert.deepStrictEqual(imported.columns.map((column: any) => column.kind), ['email', 'phone', 'boolean', 'text']);
  const page = await datasets.datasetPage(imported.id, 1, 1);
  assert.strictEqual(page.total, 2);
  assert.strictEqual(page.rows[0].rowNumber, 3);
  assert.strictEqual(page.rows[0].values.col_1, 'bob@example.com');

  const xlsx = await workbookBuffer();
  const excel = await datasets.importDataset({ provider: 'xlsx', filename: 'orders.xlsx', buffer: xlsx }, scope);
  assert.strictEqual(excel.rowCount, 1);
  assert.strictEqual(excel.columns[1].kind, 'number');

  await assert.rejects(() => datasets.importDataset({ provider: 'csv', filename: 'bad.csv', buffer: Buffer.from('Name,Name\na,b') }, scope), /Duplicate column header/);
  console.log('PASS: CSV/XLSX dataset import, normalized paging, type inference, and validation.');
}

main().catch((error) => { console.error(error); process.exit(1); });
