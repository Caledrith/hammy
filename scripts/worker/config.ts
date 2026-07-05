import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

// Load worker-specific env first (scripts/worker/.env wins), then fall back to a
// repo-root .env for anything not already set. dotenv does not override vars
// that are already defined, so this gives worker/.env precedence.
dotenvConfig({ path: resolve(process.cwd(), "scripts/worker/.env") });
dotenvConfig();

export interface WorkerConfig {
  serverUrl: string;
  workerToken: string;
  modelsRoot: string;
  bambuCliPath: string;
  outputDir: string;
  profilesRoot: string;
  pollIntervalMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Set it in scripts/worker/.env ` +
        `(see scripts/worker/.env.example).`,
    );
  }
  return v.trim();
}

export function loadConfig(): WorkerConfig {
  const pollRaw = process.env.POLL_INTERVAL_MS;
  const poll = pollRaw ? Number(pollRaw) : 15_000;
  return {
    serverUrl: required("SERVER_URL").replace(/\/+$/, ""),
    workerToken: required("WORKER_TOKEN"),
    modelsRoot: resolve(required("MODELS_ROOT")),
    bambuCliPath: required("BAMBU_CLI_PATH"),
    outputDir: resolve(required("OUTPUT_DIR")),
    profilesRoot: resolve(process.env.PROFILES_ROOT ?? resolve(process.cwd(), "profiles")),
    pollIntervalMs: Number.isFinite(poll) && poll > 0 ? poll : 15_000,
  };
}
