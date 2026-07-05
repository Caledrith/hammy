import { inflateRawSync } from "node:zlib";

// Minimal, dependency-free ZIP reader. A 3MF (and Bambu's .gcode.3mf) is just a
// ZIP archive, and we only need to pull one small text entry
// (Metadata/slice_info.config) back out, so a full unzip library is overkill.
// Handles the two compression methods 3MF uses: stored (0) and deflate (8).
// Does not support Zip64 (irrelevant for the tiny metadata archives we read).

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEocd(buf: Buffer): number {
  // EOCD is at the end, before an optional comment (<= 65535 bytes).
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: CentralEntry[] = [];

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf: Buffer, entry: CentralEntry): Buffer {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== LOC_SIG) throw new Error(`bad local header for ${entry.name}`);
  // The local header's name/extra lengths can differ from the central ones, so
  // recompute the data start from the local header.
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Return the decompressed bytes of a named entry, or null if absent. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const target = name.replace(/\\/g, "/");
  const entry = readCentralDirectory(buf).find((e) => e.name.replace(/\\/g, "/") === target);
  return entry ? extract(buf, entry) : null;
}

/** List entry names (for debugging / spike). */
export function listZipEntries(buf: Buffer): string[] {
  return readCentralDirectory(buf).map((e) => e.name);
}
