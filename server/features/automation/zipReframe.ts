/**
 * ZIP re-framing: append entries to an existing archive without recompressing it.
 *
 * A ZIP is [entry data ...][central directory][EOCD]. Appending after the data section leaves every
 * cached entry's local-header offset valid, so a new archive is the cached data section streamed
 * verbatim + the new entries + the cached central directory replayed + a fresh EOCD. That lets the
 * agent download reuse one pre-compressed runtime archive while still adding a per-user config.json,
 * with no nested ZIP for the end user to extract and an exact size known before the first byte ships.
 */

import fs from 'fs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_MIN = 22;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
// Stored (method 0): the appended entries are tiny, so compressing them would only add framing risk.
const METHOD_STORED = 0;
const VERSION_2_0 = 20;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time as stored in ZIP headers. */
function dosTime(date: Date): { time: number; date: number } {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

export type ZipLayout = {
  /** Bytes from the start of the file up to the central directory — the reusable data section. */
  dataSectionSize: number;
  /** The central directory records, verbatim. */
  centralDirectory: Buffer;
  entryCount: number;
};

/** Locate the EOCD by scanning back over the (usually empty) trailing comment. */
function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    if (i + EOCD_MIN + tail.readUInt16LE(i + 20) === tail.length) return i;
  }
  return -1;
}

/** Read the layout of an existing archive so its data section can be reused as-is. */
export function readZipLayout(zipPath: string): ZipLayout {
  const size = fs.statSync(zipPath).size;
  // The comment is capped at 64 KB, so the EOCD is always inside the last 64 KB + 22 bytes.
  const window = Math.min(size, 0xffff + EOCD_MIN);
  const tail = Buffer.alloc(window);
  const fd = fs.openSync(zipPath, 'r');
  try {
    fs.readSync(fd, tail, 0, window, size - window);
    const eocd = findEocd(tail);
    if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
    // ZIP64 would put the real sizes elsewhere; the agent bundle is far below the 4 GB / 65535 limits.
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw new Error('ZIP64 archives are not supported');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) throw new Error('ZIP64 archives are not supported');
    if (cdOffset + cdSize > size) throw new Error('corrupt ZIP (central directory runs past end of file)');

    const centralDirectory = Buffer.alloc(cdSize);
    fs.readSync(fd, centralDirectory, 0, cdSize, cdOffset);
    if (cdSize && centralDirectory.readUInt32LE(0) !== CENTRAL_SIG) throw new Error('corrupt ZIP (central directory signature mismatch)');
    return { dataSectionSize: cdOffset, centralDirectory, entryCount };
  } finally {
    fs.closeSync(fd);
  }
}

export type ExtraEntry = { name: string; data: Buffer; date?: Date };

export type FlatZipPlan = {
  /** Stream bytes [0, dataSectionSize) of the source archive, then `tail`. */
  dataSectionSize: number;
  tail: Buffer;
  /** Exact output size — usable as Content-Length before anything is streamed. */
  totalSize: number;
};

function localHeader(name: Buffer, data: Buffer, crc: number, date: Date): Buffer {
  const { time, date: day } = dosTime(date);
  const head = Buffer.alloc(LOCAL_HEADER + name.length);
  head.writeUInt32LE(LOCAL_SIG, 0);
  head.writeUInt16LE(VERSION_2_0, 4);
  head.writeUInt16LE(0, 6); // no flags: sizes are known up front, so no data descriptor
  head.writeUInt16LE(METHOD_STORED, 8);
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(day, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  name.copy(head, LOCAL_HEADER);
  return head;
}

function centralRecord(name: Buffer, data: Buffer, crc: number, date: Date, offset: number): Buffer {
  const { time, date: day } = dosTime(date);
  const rec = Buffer.alloc(CENTRAL_HEADER + name.length);
  rec.writeUInt32LE(CENTRAL_SIG, 0);
  rec.writeUInt16LE(VERSION_2_0, 4);
  rec.writeUInt16LE(VERSION_2_0, 6);
  rec.writeUInt16LE(0, 8);
  rec.writeUInt16LE(METHOD_STORED, 10);
  rec.writeUInt16LE(time, 12);
  rec.writeUInt16LE(day, 14);
  rec.writeUInt32LE(crc, 16);
  rec.writeUInt32LE(data.length, 20);
  rec.writeUInt32LE(data.length, 24);
  rec.writeUInt16LE(name.length, 28);
  rec.writeUInt32LE(0, 38); // external attributes: a plain file
  rec.writeUInt32LE(offset, 42);
  name.copy(rec, CENTRAL_HEADER);
  return rec;
}

function eocd(entryCount: number, cdSize: number, cdOffset: number): Buffer {
  const end = Buffer.alloc(EOCD_MIN);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return end;
}

/**
 * Plan a flat archive: the source's entries plus `extras`, reusing the source's compressed bytes.
 * Nothing is read or written here beyond the source's central directory — the caller streams.
 */
export function planFlatZip(layout: ZipLayout, extras: ExtraEntry[]): FlatZipPlan {
  if (layout.entryCount + extras.length > 0xffff) throw new Error('too many entries for a non-ZIP64 archive');

  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = layout.dataSectionSize;
  for (const extra of extras) {
    const name = Buffer.from(extra.name, 'utf-8');
    if (name.length > 0xffff) throw new Error(`entry name too long: ${extra.name}`);
    const date = extra.date ?? new Date();
    const crc = crc32(extra.data);
    locals.push(localHeader(name, extra.data, crc, date), extra.data);
    records.push(centralRecord(name, extra.data, crc, date, offset));
    offset += LOCAL_HEADER + name.length + extra.data.length;
  }

  const extraRecords = Buffer.concat(records);
  const cdSize = layout.centralDirectory.length + extraRecords.length;
  if (offset + cdSize > 0xffffffff) throw new Error('archive too large for a non-ZIP64 archive');

  const tail = Buffer.concat([
    ...locals,
    layout.centralDirectory,
    extraRecords,
    eocd(layout.entryCount + extras.length, cdSize, offset),
  ]);
  return { dataSectionSize: layout.dataSectionSize, tail, totalSize: layout.dataSectionSize + tail.length };
}
