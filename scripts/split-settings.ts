/**
 * Split a flattened Bambu Studio settings dump into the three profile JSONs
 * the worker needs (machine / process / filament).
 *
 * The dump comes from the Bambu Studio CLI:
 *   bambu-studio --export-settings full.json your-project.3mf
 *
 * Each key in the dump is classified by checking which of Bambu Studio's own
 * stock profile folders (resources/profiles/BBL/{machine,process,filament})
 * contain that key, so classification always matches the installed version.
 * Output paths come from profiles/manifest.json for the given model/material.
 *
 * Usage (run from the repo root on the machine with Bambu Studio installed):
 *   npm run split-settings -- full-pla.json --model P1S --material PLA
 *   npm run split-settings -- full-petg.json --model P1S --material PETG --only filament
 *
 * Options:
 *   --model M         printer model key in manifest.machineByModel (e.g. P1S)
 *   --material M      material key in manifest.filamentByMaterial (e.g. PLA)
 *   --only C          write only one of: machine, process, filament
 *   --resources DIR   Bambu Studio BBL profiles dir (auto-detected by default)
 *   --profiles-root D output profiles folder (default: <repo>/profiles)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

type Category = "machine" | "process" | "filament";
const CATEGORIES: Category[] = ["machine", "process", "filament"];

// Preset metadata; never copied from the dump, set per output file instead.
// `inherits` is deliberately dropped: the CLI cannot resolve inheritance.
const META_KEYS = new Set([
  "type",
  "name",
  "from",
  "inherits",
  "setting_id",
  "instantiation",
]);

// Dump keys we consume for output names rather than classify.
const NAME_KEYS = new Set([
  "printer_settings_id",
  "print_settings_id",
  "filament_settings_id",
]);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const val = argv[++i];
      if (val === undefined) fail(`missing value for ${a}`);
      opts[a.slice(2)] = val;
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function defaultResourcesRoot(): string | null {
  const candidates = [
    "C:\\Program Files\\Bambu Studio\\resources\\profiles\\BBL",
    "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Union of setting keys across every stock profile JSON in a category dir. */
function collectCategoryKeys(resourcesRoot: string, category: Category): Set<string> {
  const dir = join(resourcesRoot, category);
  if (!existsSync(dir)) fail(`stock profile folder not found: ${dir}`);
  const keys = new Set<string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!rel.toLowerCase().endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, rel), "utf8"));
      for (const k of Object.keys(parsed)) {
        if (!META_KEYS.has(k)) keys.add(k);
      }
    } catch {
      // Non-profile or malformed JSON in the resources tree; ignore.
    }
  }
  if (keys.size === 0) fail(`no profile keys found under ${dir}`);
  return keys;
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  return undefined;
}

const { opts, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 1) {
  fail(
    "usage: npm run split-settings -- <full-dump.json> --model P1S --material PLA [--only filament]",
  );
}

const only = opts.only as Category | undefined;
if (only && !CATEGORIES.includes(only)) {
  fail(`--only must be one of: ${CATEGORIES.join(", ")}`);
}
const model = opts.model ?? fail("--model is required (e.g. --model P1S)");
const material =
  opts.material ?? fail("--material is required (e.g. --material PLA)");

const repoRoot = resolve(import.meta.dirname, "..");
const profilesRoot = resolve(opts["profiles-root"] ?? join(repoRoot, "profiles"));
const resourcesRoot = opts.resources ?? defaultResourcesRoot();
if (!resourcesRoot) {
  fail(
    "could not find Bambu Studio's resources/profiles/BBL folder; pass it with --resources",
  );
}

const dumpPath = resolve(positional[0]);
if (!existsSync(dumpPath)) fail(`dump file not found: ${dumpPath}`);
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, unknown>;
const dumpKeyCount = Object.keys(dump).length;
if (dumpKeyCount < 100) {
  console.warn(
    `warning: dump has only ${dumpKeyCount} keys; a flattened full config normally has hundreds. ` +
      "This looks like a delta preset (see profiles/README.md).",
  );
}
if ("inherits" in dump && firstString(dump.inherits)) {
  console.warn(
    `warning: dump contains inherits="${dump.inherits}"; it will be dropped, ` +
      "but verify the dump is really a full flattened config.",
  );
}

const manifestPath = join(profilesRoot, "manifest.json");
if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  machineByModel: Record<string, string>;
  processByModel: Record<string, string>;
  filamentByMaterial: Record<string, string>;
};

const outRel: Record<Category, string | undefined> = {
  machine: manifest.machineByModel[model],
  process: manifest.processByModel[model],
  filament: manifest.filamentByMaterial[material],
};

const keySets = {} as Record<Category, Set<string>>;
for (const c of CATEGORIES) keySets[c] = collectCategoryKeys(resourcesRoot, c);

const outputs: Record<Category, Record<string, unknown>> = {
  machine: {},
  process: {},
  filament: {},
};
const leftovers: string[] = [];
for (const [key, value] of Object.entries(dump)) {
  if (META_KEYS.has(key) || NAME_KEYS.has(key)) continue;
  const matched = CATEGORIES.filter((c) => keySets[c].has(key));
  if (matched.length === 0) {
    leftovers.push(key);
    continue;
  }
  for (const c of matched) outputs[c][key] = value;
}

const names: Record<Category, string> = {
  machine: firstString(dump.printer_settings_id) ?? `${model} machine`,
  process: firstString(dump.print_settings_id) ?? `${model} process`,
  filament: firstString(dump.filament_settings_id) ?? material,
};

const targets = only ? [only] : CATEGORIES;
for (const c of targets) {
  const rel = outRel[c];
  if (!rel) {
    fail(
      c === "filament"
        ? `manifest.json has no filamentByMaterial entry for "${material}"`
        : `manifest.json has no ${c} entry for model "${model}"`,
    );
  }
  const outPath = join(profilesRoot, rel);
  const body = {
    type: c,
    name: names[c],
    from: "User",
    instantiation: "true",
    ...outputs[c],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(body, null, 2) + "\n");
  console.log(
    `wrote ${outPath} (${Object.keys(outputs[c]).length} settings, name="${names[c]}")`,
  );
}

if (leftovers.length > 0) {
  console.log(
    `\nskipped ${leftovers.length} key(s) not present in any stock profile category ` +
      "(usually project-only metadata):",
  );
  console.log(`  ${leftovers.sort().join(", ")}`);
}
