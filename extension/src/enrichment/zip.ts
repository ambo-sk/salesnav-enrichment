/**
 * Minimal streaming ZIP writer (deflate, no zip64).
 *
 * Exists because building the workbook in memory does not fit a Worker.
 * SheetJS's `XLSX.write` materializes the whole sheet XML plus the shared-string
 * table as contiguous JS strings before zipping — measured at roughly 40x the
 * final file size, which blows the 128 MB isolate at ~150 contacts even though
 * the source data is only ~12 MB. This writer never holds the uncompressed
 * bytes: each part is fed through the platform's CompressionStream one row at a
 * time, and only the COMPRESSED output is retained (a few MB for a 1000-contact
 * workbook).
 *
 * Compressed output is buffered per entry rather than streamed straight out so
 * the local file header can carry a real CRC and sizes. Data descriptors would
 * avoid even that, but not every spreadsheet reader honours them, and a few MB
 * is not worth the compatibility risk.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** One file in the archive. `chunks` is pulled lazily so the caller can emit
 *  a worksheet row by row instead of building it whole. */
export interface ZipEntry {
  name: string;
  chunks: () => Iterable<string> | AsyncIterable<string>;
}

interface StagedEntry {
  nameBytes: Uint8Array;
  crc: number;
  rawSize: number;
  compressed: Uint8Array;
}

/** DOS date/time. Taken from the caller so the archive is byte-reproducible —
 *  a Workflow step that replays must not produce a different file. */
export interface DosStamp {
  time: number;
  date: number;
}

export function dosStamp(date: Date): DosStamp {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (Math.floor(date.getUTCSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

async function stage(entry: ZipEntry): Promise<StagedEntry> {
  const encoder = new TextEncoder();
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const compressedChunks: Uint8Array[] = [];
  let compressedSize = 0;
  let crc = 0xffffffff;
  let rawSize = 0;

  // Drain concurrently with writing: CompressionStream applies backpressure, and
  // writing everything before reading would queue the whole part in memory —
  // exactly the failure this writer exists to avoid.
  const draining = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedChunks.push(value);
      compressedSize += value.length;
    }
  })();

  for await (const chunk of entry.chunks()) {
    if (!chunk) continue;
    const bytes = encoder.encode(chunk);
    rawSize += bytes.length;
    crc = crc32Update(crc, bytes);
    await writer.write(bytes);
  }
  await writer.close();
  await draining;

  const compressed = new Uint8Array(compressedSize);
  let offset = 0;
  for (const chunk of compressedChunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    nameBytes: encoder.encode(entry.name),
    crc: (crc ^ 0xffffffff) >>> 0,
    rawSize,
    compressed,
  };
}

/**
 * Build the archive. Entries are staged one at a time, so peak memory is the
 * compressed archive plus the single part currently being compressed.
 */
export async function zip(entries: ZipEntry[], stamp: DosStamp): Promise<Uint8Array> {
  const staged: StagedEntry[] = [];
  for (const entry of entries) {
    staged.push(await stage(entry));
  }

  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;

  let size = EOCD;
  for (const entry of staged) {
    size += LOCAL_HEADER + entry.nameBytes.length + entry.compressed.length;
    size += CENTRAL_HEADER + entry.nameBytes.length;
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;

  const u16 = (value: number) => {
    view.setUint16(pos, value, true);
    pos += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(pos, value >>> 0, true);
    pos += 4;
  };
  const raw = (bytes: Uint8Array) => {
    out.set(bytes, pos);
    pos += bytes.length;
  };

  // Bit 11 flags UTF-8 filenames. Every name here is ASCII, but the flag costs
  // nothing and keeps the archive correct if a part is ever renamed.
  const FLAGS = 0x0800;
  const DEFLATE = 8;

  const offsets: number[] = [];

  for (const entry of staged) {
    offsets.push(pos);
    u32(0x04034b50);
    u16(20);
    u16(FLAGS);
    u16(DEFLATE);
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.compressed.length);
    u32(entry.rawSize);
    u16(entry.nameBytes.length);
    u16(0);
    raw(entry.nameBytes);
    raw(entry.compressed);
  }

  const centralStart = pos;

  for (const [index, entry] of staged.entries()) {
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16(FLAGS);
    u16(DEFLATE);
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.compressed.length);
    u32(entry.rawSize);
    u16(entry.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(offsets[index]);
    raw(entry.nameBytes);
  }

  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(staged.length);
  u16(staged.length);
  u32(pos - centralStart);
  u32(centralStart);
  u16(0);

  return out;
}
