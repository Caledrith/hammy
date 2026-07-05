import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Push a model-library listing to the running server, which does the DB write
 * server-side. Use this when the box you're on can reach the server URL but not
 * the database directly (e.g. DB is only reachable over VPN / on a private LAN).
 *
 * The listing is sent in batches so each HTTP request stays small and fast —
 * this avoids reverse-proxy body-size limits and read timeouts (a single large
 * request can otherwise surface as a 502/504 at nginx/Cloudflare). The import
 * route is idempotent, so batched calls are safe.
 *
 * Reaches the server only, not the DB. SERVER_URL + WORKER_TOKEN come from env
 * (or flags). Usage:
 *   npm run push-files -- --server=https://hammy.johnmorgannemelka.com
 *   SERVER_URL=... WORKER_TOKEN=... npm run push-files
 *   npm run push-files -- --file=stl-files.txt --batch=2000
 */

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

interface ImportResult {
  ok?: boolean;
  total?: number;
  inserted?: number;
  skipped?: number;
  error?: string;
}

async function main() {
  const file = argValue("file") ?? "stl-files.txt";
  const server = (argValue("server") ?? process.env.SERVER_URL ?? "").replace(/\/+$/, "");
  const token = argValue("token") ?? process.env.WORKER_TOKEN ?? "";
  const batchSize = Math.max(1, Number(argValue("batch") ?? 2000));

  if (!server) throw new Error("set --server=<url> or SERVER_URL");
  if (!token) throw new Error("set --token=<token> or WORKER_TOKEN");

  const lines = readFileSync(resolve(process.cwd(), file), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const url = `${server}/api/admin/import-files`;
  const batches = Math.ceil(lines.length / batchSize);
  console.log(
    `Pushing ${lines.length} lines from ${file} to ${url} in ${batches} batch(es) of ${batchSize} ...`,
  );

  const totals = { total: 0, inserted: 0, skipped: 0 };

  for (let i = 0; i < lines.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const body = lines.slice(i, i + batchSize).join("\n");

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
      body,
    });

    const parsed = (await res.json().catch(() => ({}))) as ImportResult;
    if (!res.ok) {
      console.error(`  batch ${batchNum}/${batches} FAILED: ${res.status}`, parsed);
      throw new Error(`push aborted at batch ${batchNum} (HTTP ${res.status})`);
    }

    totals.total += parsed.total ?? 0;
    totals.inserted += parsed.inserted ?? 0;
    totals.skipped += parsed.skipped ?? 0;
    console.log(
      `  batch ${batchNum}/${batches}: +${parsed.inserted ?? 0} new ` +
        `(${parsed.total ?? 0} in batch)`,
    );
  }

  console.log(
    `\nDone. Inserted ${totals.inserted} new files across ${lines.length} paths ` +
      `(existing rows left untouched).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\npush-file-listing failed:\n", err);
    process.exit(1);
  });
