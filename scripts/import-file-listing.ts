import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../src/db";
import { importListing, parseListing } from "../src/lib/catalog/import-files";

/**
 * Import a plain-text listing of the STL library into printable_files, connecting
 * DIRECTLY to the database. Use this when the machine running it can reach the
 * DB. If it can't (DB not exposed), push the listing to the running server
 * instead: `npm run push-files` (POST /api/admin/import-files).
 *
 * Usage:
 *   npm run import-files                 # reads ./stl-files.txt
 *   npm run import-files -- --file=x.txt
 *   npm run import-files -- --dry-run
 */

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

async function main() {
  const file = argValue("file") ?? "stl-files.txt";
  const dryRun = process.argv.includes("--dry-run");
  const text = readFileSync(resolve(process.cwd(), file), "utf8");

  const { records, skipped } = parseListing(text);
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
  const result = await importListing(db, text);
  console.log(
    `\nDone. Inserted ${result.inserted} new files, ` +
      `${result.total - result.inserted} already present.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nimport-file-listing failed:\n", err);
    process.exit(1);
  });
