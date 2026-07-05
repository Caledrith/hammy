import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClaimedPlate } from "../../src/lib/worker/types";
import type { WorkerConfig } from "./config";

// Hard cap on a single slice so a hung CLI can't strand the worker.
const SLICE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MODEL = "P1S";

/**
 * Maps machine/process/filament presets to exported Bambu Studio profile JSONs.
 * Paths are relative to profilesRoot. The operator fills this in from real
 * exports (Bambu Studio -> preset dropdown -> Export). See profiles/README.md.
 */
interface ProfileManifest {
  machineByModel: Record<string, string>;
  processByModel: Record<string, string>;
  filamentByMaterial: Record<string, string>;
}

export class ProfileError extends Error {}

export interface SliceInput {
  absPath: string;
  quantity: number;
}

export interface SliceRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outPath: string;
  args: string[];
  timedOut: boolean;
}

function loadManifest(profilesRoot: string): ProfileManifest {
  const manifestPath = resolve(profilesRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ProfileError(`profile manifest not found at ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ProfileManifest;
}

function resolveProfile(
  profilesRoot: string,
  rel: string | undefined,
  kind: string,
): string {
  if (!rel) throw new ProfileError(`no ${kind} profile mapped`);
  const abs = resolve(profilesRoot, rel);
  if (!existsSync(abs)) throw new ProfileError(`${kind} profile missing on disk: ${abs}`);
  return abs;
}

/** Translate our plate_type label to a Bambu `--curr-bed-type` value. */
export function bedTypeFor(plateType: string | null): string {
  const p = (plateType ?? "").toLowerCase();
  if (p.includes("textured")) return "Textured PEI Plate";
  if (p.includes("smooth")) return "Smooth PEI Plate";
  if (p.includes("engineering")) return "Engineering Plate";
  if (p.includes("high")) return "High Temp Plate";
  if (p.includes("cool")) return "Cool Plate";
  return "Textured PEI Plate";
}

/**
 * Resolve the three profiles a plate needs. Throws ProfileError (so the caller
 * can fail the plate with a clear reason) when a preset isn't mapped/exported.
 */
export function resolveProfiles(config: WorkerConfig, plate: ClaimedPlate) {
  const manifest = loadManifest(config.profilesRoot);
  const model = plate.targetPrinterModel ?? DEFAULT_MODEL;
  const material = plate.material ?? "";
  return {
    machine: resolveProfile(config.profilesRoot, manifest.machineByModel[model], `machine (${model})`),
    process: resolveProfile(config.profilesRoot, manifest.processByModel[model], `process (${model})`),
    filament: resolveProfile(
      config.profilesRoot,
      manifest.filamentByMaterial[material],
      `filament (${material})`,
    ),
  };
}

/**
 * Build the Bambu Studio CLI argv. Copies are produced by repeating a model's
 * path once per unit. The exact flag set is confirmed by the CLI spike (see
 * scripts/worker/README.md) and centralized here so it is the only place to
 * adjust when a Studio version changes behavior.
 */
export function buildArgs(opts: {
  machine: string;
  process: string;
  filament: string;
  bedType: string;
  outPath: string;
  files: SliceInput[];
}): string[] {
  const modelArgs: string[] = [];
  for (const f of opts.files) {
    for (let i = 0; i < f.quantity; i++) modelArgs.push(f.absPath);
  }
  return [
    "--load-settings",
    `${opts.machine};${opts.process}`,
    "--load-filaments",
    opts.filament,
    "--curr-bed-type",
    opts.bedType,
    "--arrange",
    "1",
    "--orient",
    "1",
    "--slice",
    "0",
    "--export-3mf",
    opts.outPath,
    ...modelArgs,
  ];
}

export function runSlice(
  config: WorkerConfig,
  plate: ClaimedPlate,
  files: SliceInput[],
): Promise<SliceRun> {
  const profiles = resolveProfiles(config, plate);
  const outPath = resolve(config.outputDir, `plate-${plate.id}.gcode.3mf`);
  const args = buildArgs({
    machine: profiles.machine,
    process: profiles.process,
    filament: profiles.filament,
    bedType: bedTypeFor(plate.plateType),
    outPath,
    files,
  });

  return new Promise<SliceRun>((resolvePromise) => {
    const child = spawn(config.bambuCliPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SLICE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${err.message}`, outPath, args, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, outPath, args, timedOut });
    });
  });
}
