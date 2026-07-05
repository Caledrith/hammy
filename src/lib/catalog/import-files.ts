import type { Database } from "../../db";
import { printableFiles } from "../../db/schema";

// Shared model-library import: parse a plain-text listing of the STL library
// (one relative path per line) and register the paths in printable_files. Used
// by both the CLI script (scripts/import-file-listing.ts) and the HTTP route
// (POST /api/admin/import-files), so the parsing/upsert behavior can't diverge.
//
// The server only indexes NAMES, never geometry bytes. Paths are normalized to
// forward slashes and stored relative to the library root; the worker resolves
// them against MODELS_ROOT on the machine that slices.

const CHUNK_SIZE = 500;

export interface ListingRecord {
  partType: string;
  filePath: string;
}

export interface ParsedListing {
  records: ListingRecord[];
  /** Duplicate lines skipped during parse. */
  skipped: number;
}

export interface ImportResult {
  total: number;
  inserted: number;
  skipped: number;
}

/** Normalize a raw listing line to a canonical forward-slashed relative path. */
export function normalizeListingPath(line: string): string {
  return line.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Derive a part_type from the top-level folder, defaulting to "print". */
export function partTypeFor(path: string): string {
  const idx = path.indexOf("/");
  if (idx <= 0) return "print";
  return path.slice(0, idx).trim().toLowerCase() || "print";
}

/** Parse listing text into deduped, normalized records. */
export function parseListing(text: string): ParsedListing {
  const seen = new Set<string>();
  const records: ListingRecord[] = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const path = normalizeListingPath(line);
    if (!path) continue;
    if (seen.has(path)) {
      skipped += 1;
      continue;
    }
    seen.add(path);
    records.push({ partType: partTypeFor(path), filePath: path });
  }
  return { records, skipped };
}

/**
 * Parse + upsert a listing into printable_files. Idempotent: inserts new paths,
 * leaves existing rows (and any curated est_grams / mappings) untouched.
 */
export async function importListing(db: Database, text: string): Promise<ImportResult> {
  const { records, skipped } = parseListing(text);
  let inserted = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .insert(printableFiles)
      .values(chunk)
      .onConflictDoNothing({ target: printableFiles.filePath })
      .returning({ id: printableFiles.id });
    inserted += rows.length;
  }

  return { total: records.length, inserted, skipped };
}
