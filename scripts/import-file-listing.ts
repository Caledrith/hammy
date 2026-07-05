import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../src/db";
import { printableFiles } from "../src/db/schema";

/**
 * Import a plain-text listing of the STL library (one relative path per line,
 * as produced on the shop PC, e.g. `dir /b /s` output) into printable_files.
 *
 * The server only indexes NAMES, never the geometry bytes. Paths are normalized
 * to forward slashes and stored relative to the library root; the worker
 * resolves them against MODELS_ROOT on the machine that actually slices.
 *
 * Idempotent: inserts new paths, leaves existing rows (and any curated
 * est_grams / part mappings) untouched. part_type is derived from the top-level
 * folder so files group sensibly, defaulting to "print" for root-level files.
 *
 * Usage:
 *   npm run import-files                 # reads ./stl-files.txt
 *   npm run import-files -- --file=x.txt
 *   npm run import-files -- --dry-run
 */

const CHUNK_SIZE = 500;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function normalizePath(line: string): string {
  return line.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function partTypeFor(path: string): string {
  const idx = path.indexOf("/");
  if (idx <= 0) return "print";
  return path.slice(0, idx).trim().toLowerCase() || "print";
}

async function main() {
  const file = argValue("file") ?? "stl-files.txt";
  const dryRun = process.argv.includes("--dry-run");
  const filePath = resolve(process.cwd(), file);

  const raw = readFileSync(filePath, "utf8");
  const seen = new Set<string>();
  const records: { partType: string; filePath: string }[] = [];
  let skipped = 0;

  for (const line of raw.split(/\r?\n/)) {
    const path = normalizePath(line);
    if (!path) continue;
    if (seen.has(path)) {
      skipped += 1;
      continue;
    }
    seen.add(path);
    records.push({ partType: partTypeFor(path), filePath: path });
  }

  console.log(
    `Parsed ${records.length} unique paths from ${file}` +
      (skipped ? ` (${skipped} duplicate lines skipped)` : ""),
  );

  if (dryRun) {
    const byPart = new Map<string, number>();
    for (const r of records) byPart.set(r.partType, (byPart.get(r.partType) ?? 0) + 1);
    console.log("\nPart types (dry run, nothing written):");
    for (const [part, count] of [...byPart.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${part.padEnd(16)} ${count}`);
    }
    return;
  }

  const db = getDb();
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .insert(printableFiles)
      .values(chunk)
      .onConflictDoNothing({ target: printableFiles.filePath })
      .returning({ id: printableFiles.id });
    inserted += rows.length;
    process.stdout.write(`  ...${Math.min(i + CHUNK_SIZE, records.length)}/${records.length}\r`);
  }

  console.log(
    `\nDone. Inserted ${inserted} new files, ${records.length - inserted} already present.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nimport-file-listing failed:\n", err);
    process.exit(1);
  });
