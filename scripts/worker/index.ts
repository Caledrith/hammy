import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ClaimedPlate } from "../../src/lib/worker/types";
import { claimPlate, completePlate, failPlate } from "./api";
import { ProfileError, runSlice, type SliceInput } from "./cli";
import { loadConfig, type WorkerConfig } from "./config";
import { readSliceInfo } from "./sliceinfo";

/**
 * Slicer worker. Runs on the shop PC (the machine with the STL library, Bambu
 * Studio CLI, and printers). Polls the server for draft plates, resolves model
 * paths locally, slices with the CLI, and reports real estimates back. Only
 * outbound HTTPS is used, so the PC needs no inbound ports.
 */

let running = true;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(-n) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function processPlate(config: WorkerConfig, plate: ClaimedPlate): Promise<void> {
  // Resolve every model path against the local library and verify it exists
  // before invoking the slicer (fail fast with a precise list).
  const missing: string[] = [];
  const files: SliceInput[] = [];
  for (const f of plate.files) {
    if (!f.path) {
      missing.push(`(job ${f.printJobId}: no path)`);
      continue;
    }
    const abs = resolve(config.modelsRoot, f.path);
    if (existsSync(abs)) files.push({ absPath: abs, quantity: f.quantity });
    else missing.push(f.path);
  }

  if (missing.length > 0) {
    await failPlate(config, plate.id, {
      reason: `missing ${missing.length} model file(s) under MODELS_ROOT`,
      detail: missing.join("\n"),
    });
    log(`plate ${plate.id}: FAILED (missing files: ${missing.length})`);
    return;
  }
  if (files.length === 0) {
    await failPlate(config, plate.id, { reason: "plate has no files to slice" });
    log(`plate ${plate.id}: FAILED (empty)`);
    return;
  }

  let run;
  try {
    run = await runSlice(config, plate, files);
  } catch (err) {
    if (err instanceof ProfileError) {
      await failPlate(config, plate.id, { reason: "profile resolution failed", detail: err.message });
      log(`plate ${plate.id}: FAILED (${err.message})`);
      return;
    }
    throw err;
  }

  if (run.timedOut) {
    await failPlate(config, plate.id, { reason: "slice timed out", detail: tail(run.stderr) });
    log(`plate ${plate.id}: FAILED (timeout)`);
    return;
  }
  if (run.code !== 0 || !existsSync(run.outPath)) {
    await failPlate(config, plate.id, {
      reason: `slicer exited with code ${run.code}`,
      detail: tail(run.stderr || run.stdout),
    });
    log(`plate ${plate.id}: FAILED (exit ${run.code})`);
    return;
  }

  const info = readSliceInfo(run.outPath);
  await completePlate(config, plate.id, {
    estMinutes: info.estMinutes,
    estGrams: info.estGrams,
    objectCount: info.objectCount,
    artifactFilename: basename(run.outPath),
  });
  log(
    `plate ${plate.id}: SLICED -> ${basename(run.outPath)} ` +
      `(${info.estGrams ?? "?"}g, ${info.estMinutes ?? "?"}min, ${info.plateCount} bed plate(s))`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!existsSync(config.modelsRoot)) {
    throw new Error(`MODELS_ROOT does not exist: ${config.modelsRoot}`);
  }
  mkdirSync(config.outputDir, { recursive: true });
  log(
    `worker started. server=${config.serverUrl} models=${config.modelsRoot} ` +
      `out=${config.outputDir} poll=${config.pollIntervalMs}ms`,
  );

  while (running) {
    let didWork = false;
    try {
      const { plate } = await claimPlate(config);
      if (plate) {
        didWork = true;
        log(
          `claimed plate ${plate.id}: ${plate.material}/${plate.color} ` +
            `${plate.nozzle}mm ${plate.plateType} -> ${plate.targetPrinterModel} ` +
            `(${plate.files.length} file(s))`,
        );
        await processPlate(config, plate);
      }
    } catch (err) {
      log("loop error:", err instanceof Error ? err.message : String(err));
    }
    // Drain the queue back-to-back; only idle-sleep when there was nothing to do.
    if (!didWork) await sleep(config.pollIntervalMs);
  }
  log("worker stopped.");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} received; finishing current plate then exiting...`);
    running = false;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
