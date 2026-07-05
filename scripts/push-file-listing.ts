import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Push a model-library listing to the running server, which does the DB write
 * server-side. Use this when the box you're on can reach the server URL but not
 * the database directly (e.g. DB is only reachable over VPN / on a private LAN).
 *
 * Reaches the server only, not the DB. SERVER_URL + WORKER_TOKEN come from env
 * (or flags). Usage:
 *   npm run push-files -- --server=https://your-vm:3085
 *   SERVER_URL=... WORKER_TOKEN=... npm run push-files
 *   npm run push-files -- --file=stl-files.txt
 */

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

async function main() {
  const file = argValue("file") ?? "stl-files.txt";
  const server = (argValue("server") ?? process.env.SERVER_URL ?? "").replace(/\/+$/, "");
  const token = argValue("token") ?? process.env.WORKER_TOKEN ?? "";

  if (!server) throw new Error("set --server=<url> or SERVER_URL");
  if (!token) throw new Error("set --token=<token> or WORKER_TOKEN");

  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  console.log(`Pushing ${file} (${text.length} bytes) to ${server}/api/admin/import-files ...`);

  const res = await fetch(`${server}/api/admin/import-files`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
    body: text,
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`push failed: ${res.status}`, body);
    process.exit(1);
  }
  console.log("Done:", body);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\npush-file-listing failed:\n", err);
    process.exit(1);
  });
