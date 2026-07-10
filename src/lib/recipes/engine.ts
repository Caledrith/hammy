import { and, eq, ilike } from "drizzle-orm";
import type { Database } from "../../db";
import { filamentMap, opticAliases, partVariants } from "../../db/schema";
import { canonicalizeMaterial, normalizeOptic, normalizeValue } from "./normalize";
import { ruleSetSchema, type LineItemInput, type RuleSet } from "./types";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface ResolvedJob {
  partType: string;
  opticModel: string | null;
  printableFileId: number | null;
  quantity: number;
  materialOption: string | null;
  colorOption: string | null;
  filamentMaterial: string | null;
  colorHex: string | null;
  slicerProfile: string | null;
  status: "ready" | "needs_review";
  reviewReason: string | null;
  reviewKind: "no_bom_rule" | "filament_unknown" | null;
}

export interface ResolvedBom {
  kind: "printed" | "hardware";
  ref: string;
  quantity: number;
}

export interface ResolveResult {
  jobs: ResolvedJob[];
  bom: ResolvedBom[];
  resolutionStatus: "resolved" | "needs_review";
  /** Extracted options, for debugging / display. */
  extracted: {
    material: string | null;
    color: string | null;
    optic: string | null;
  };
}

// ---------------------------------------------------------------------------
// Option extraction (pure)
// ---------------------------------------------------------------------------

interface Attr {
  key: string;
  value: string;
}

interface ExtractedContext {
  attrs: Attr[];
  variantTokens: string[];
  valuePool: Set<string>;
  material: string | null;
  color: string | null;
  optic: string | null;
}

const DEFAULT_EXCLUDE_KEYS = [
  "color",
  "lens to cover",
  "hex style",
  "scope manufacturer",
  "scope cover manufacturer",
  "manufacturer",
  "scope end",
];

const DEFAULT_MANUFACTURER_KEYS = [
  "Scope Manufacturer",
  "Scope Cover Manufacturer",
  "Manufacturer",
  "Optic Manufacturer",
];

/**
 * Property keys that commonly hold a product's model/label across the catalog
 * (weapon-light clamps, silencer cases/mounts, etc.). Tried as a fallback after
 * explicit recipe candidates and the manufacturer strategy, so a product like
 * the "Tip Grip - Flashlight and Scope Clamp" surfaces its flashlight model
 * ("Cloud Defensive Rein 3.0") even without a bespoke recipe. Prefix-matched,
 * so numbered variants ("Flashlight-4") are covered too.
 */
const DEFAULT_OPTIC_CANDIDATES = ["Flashlight", "Light Model", "Silencer Model", "Model"];

/** Values that are present but carry no real model (skip so N/A never displays). */
function isNoOpticValue(value: string | null | undefined): boolean {
  const v = normalizeValue(value ?? "");
  return v === "" || v === "na" || v === "none" || v === "other" || v === "not listed";
}

function keyMatches(attrKey: string, candidate: string): boolean {
  const k = normalizeValue(attrKey);
  const c = normalizeValue(candidate);
  return k === c || k.startsWith(c);
}

function findAttr(attrs: Attr[], candidates: string[]): Attr | null {
  for (const cand of candidates) {
    const hit = attrs.find((a) => keyMatches(a.key, cand));
    if (hit) return hit;
  }
  return null;
}

/** Like findAttr, but skips candidates whose value is a placeholder (N/A, etc.). */
function findAttrWithValue(attrs: Attr[], candidates: string[]): Attr | null {
  for (const cand of candidates) {
    const hit = attrs.find((a) => keyMatches(a.key, cand) && !isNoOpticValue(a.value));
    if (hit) return hit;
  }
  return null;
}

/**
 * Best-effort brand/manufacturer for display (e.g. "Leupold" shown before the
 * scope model). Reads the same manufacturer-keyed property the optic strategy
 * uses. Returns null when absent or "Other" (free-text model, no real brand).
 */
export function brandFromProperties(
  properties: { name: string; value: string }[],
): string | null {
  const attrs: Attr[] = properties.map((p) => ({ key: p.name, value: p.value }));
  const hit = findAttr(attrs, DEFAULT_MANUFACTURER_KEYS);
  if (!hit) return null;
  const value = hit.value.trim();
  if (!value || normalizeValue(value) === "other") return null;
  return value;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detect the material keyword and the pool token it came from. */
function detectMaterialInfo(
  pool: string[],
  keywords: string[],
): { material: string | null; token: string | null } {
  // Longest keyword first so "PETG-CF" wins over "PETG", "PLA+" over "PLA".
  const ordered = [...keywords].sort((a, b) => b.length - a.length);
  for (const token of pool) {
    for (const kw of ordered) {
      if (token.toLowerCase().includes(kw.toLowerCase())) return { material: kw, token };
    }
  }
  return { material: null, token: null };
}

/** Remove a leading material prefix from a color value (e.g. "PETG-CF Black" -> "Black"). */
function stripMaterialPrefix(value: string, material: string | null): string {
  if (!material) return value.trim();
  const re = new RegExp(`^${escapeRegExp(material)}\\s*`, "i");
  return value.replace(re, "").trim() || value.trim();
}

/** Strip leading/trailing separator noise (`: , / + - |`) and whitespace. */
function trimSeparators(value: string): string {
  return value.replace(/^[\s:,/+\-|]+|[\s:,/+\-|]+$/g, "").trim();
}

/**
 * Find a known color inside any of the candidate strings. Longest vocabulary
 * phrase wins globally (so "Olive Green" beats "Green", "Earth Brown" beats
 * "Brown"), matched on word boundaries so "Black" is found inside "PETG-CF
 * Black" but not inside "Blackout". Returns the vocabulary's canonical casing.
 */
function detectColorFromVocab(strings: string[], vocab: string[]): string | null {
  const ordered = [...vocab].sort((a, b) => b.length - a.length);
  for (const term of ordered) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    for (const s of strings) {
      if (re.test(s)) return term;
    }
  }
  return null;
}

/**
 * Locate the optic/model string. Strategy order (first hit wins):
 *   1. Explicit recipe candidates.
 *   2. Manufacturer strategy (scope model keyed by its brand).
 *   3. Common model-bearing keys (Flashlight, Silencer Model, Model, ...).
 *   4. Leftover heuristic (the single non-meta property).
 * Placeholder values ("N/A", "Not Listed", ...) are skipped so an either/or
 * product (scope OR flashlight) resolves to whichever was actually chosen.
 */
function extractOptic(attrs: Attr[], ruleSet: RuleSet): string | null {
  const strat = ruleSet.optic ?? {};

  // 1. Explicit candidates.
  if (strat.candidates?.length) {
    const hit = findAttrWithValue(attrs, strat.candidates);
    if (hit) return hit.value;
  }

  // 2. Manufacturer strategy: read manufacturer, then find a property keyed by it.
  const mfrKeys = strat.manufacturerKeys ?? DEFAULT_MANUFACTURER_KEYS;
  const mfrAttr = findAttr(attrs, mfrKeys);
  if (mfrAttr && normalizeValue(mfrAttr.value) !== "other") {
    const mfr = mfrAttr.value;
    const wanted = [mfr, `${mfr} optic`, `${mfr} model`, `${mfr} red dot`];
    const hit = attrs.find(
      (a) =>
        a !== mfrAttr &&
        wanted.some((w) => normalizeValue(a.key) === normalizeValue(w)) &&
        !isNoOpticValue(a.value),
    );
    if (hit) return hit.value;
    // Manufacturer present but the model key just starts with it.
    const startsHit = attrs.find(
      (a) =>
        a !== mfrAttr &&
        normalizeValue(a.key).startsWith(normalizeValue(mfr)) &&
        !isNoOpticValue(a.value),
    );
    if (startsHit) return startsHit.value;
  }

  // 3. Common model-bearing keys (fallback for products without a bespoke recipe).
  const modelHit = findAttrWithValue(attrs, DEFAULT_OPTIC_CANDIDATES);
  if (modelHit) return modelHit.value;

  // 4. Leftover heuristic: the one property that isn't a known meta field.
  const exclude = (strat.excludeKeys ?? DEFAULT_EXCLUDE_KEYS).map(normalizeValue);
  const leftovers = attrs.filter((a) => {
    const k = normalizeValue(a.key);
    return !exclude.some((ex) => k === ex || k.startsWith(ex));
  });
  if (leftovers.length === 1 && !isNoOpticValue(leftovers[0].value)) return leftovers[0].value;

  return null;
}

export function extractContext(ruleSet: RuleSet, lineItem: LineItemInput): ExtractedContext {
  const attrs: Attr[] = lineItem.properties.map((p) => ({ key: p.name, value: p.value }));
  const variantTokens = (lineItem.variantTitle ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  const valuePool = new Set<string>();
  for (const t of variantTokens) valuePool.add(normalizeValue(t));
  for (const a of attrs) valuePool.add(normalizeValue(a.value));

  const materialPool = [...variantTokens, ...attrs.map((a) => a.value)];
  const { material: detectedMaterial } = detectMaterialInfo(
    materialPool,
    ruleSet.materialKeywords,
  );
  // Collapse to the canonical stocked material (PLA -> PLA+, PETG -> PETG-CF, ...).
  const material = canonicalizeMaterial(detectedMaterial);

  // Color precedence:
  //  1. An explicit Color property (strip any material prefix + separator noise),
  //     canonicalized against the vocabulary when possible, else the cleaned value.
  //  2. Otherwise scan variant tokens + property values for a known color, so
  //     bare tokens ("Black", "PETG-CF Black", "Olive Green / 3 Slots") resolve
  //     while non-color remainders (".30 Cal Field Box - 18 Mag") stay null.
  const colorAttr = findAttr(attrs, ruleSet.colorKeys);
  let color: string | null;
  if (colorAttr) {
    // Strip using the RAW detected material ("PLA"), which is what actually
    // prefixes the color text, not the canonicalized form ("PLA+").
    const cleaned = trimSeparators(stripMaterialPrefix(colorAttr.value, detectedMaterial));
    color = detectColorFromVocab([cleaned], ruleSet.colorVocab) ?? (cleaned || null);
  } else {
    color = detectColorFromVocab(
      [...variantTokens, ...attrs.map((a) => a.value)],
      ruleSet.colorVocab,
    );
  }

  const optic = extractOptic(attrs, ruleSet);

  return { attrs, variantTokens, valuePool, material, color, optic };
}

// ---------------------------------------------------------------------------
// Rule matching (pure)
// ---------------------------------------------------------------------------

function whenMatches(when: Record<string, string | string[]> | undefined, pool: Set<string>): boolean {
  if (!when) return true;
  for (const required of Object.values(when)) {
    const options = Array.isArray(required) ? required : [required];
    const anyMet = options.some((v) => pool.has(normalizeValue(v)));
    if (!anyMet) return false;
  }
  return true;
}

interface MatchedBom {
  printed: { partType: string; fixedOptic?: string; perUnit: number }[];
  hardware: { ref: string; perUnit: number }[];
  matchedAnyRule: boolean;
}

function matchRules(ruleSet: RuleSet, pool: Set<string>): MatchedBom {
  const printed: MatchedBom["printed"] = [];
  const hardware: MatchedBom["hardware"] = [];
  let matchedAnyRule = false;

  for (const rule of ruleSet.rules) {
    if (!whenMatches(rule.when, pool)) continue;
    matchedAnyRule = true;
    for (const p of rule.printed ?? []) {
      printed.push({ partType: p.partType, fixedOptic: p.fixedOptic, perUnit: p.perUnit ?? 1 });
    }
    for (const h of rule.hardware ?? []) {
      hardware.push({ ref: h.ref, perUnit: h.perUnit ?? 1 });
    }
  }

  return { printed, hardware, matchedAnyRule };
}

// ---------------------------------------------------------------------------
// Catalog resolution (DB)
// ---------------------------------------------------------------------------

async function resolveCanonicalOptic(db: Database, optic: string): Promise<string> {
  const [alias] = await db
    .select()
    .from(opticAliases)
    .where(eq(opticAliases.normalizedSource, normalizeOptic(optic)))
    .limit(1);
  return alias?.canonicalOptic ?? optic;
}

/**
 * Resolve an optic + part to a physical file via the part_variants mapping.
 * Many optics/sizes can point at one printable file; returns the file id plus
 * the canonical optic label to store on the job.
 */
async function findPrintableFile(
  db: Database,
  partType: string,
  optic: string,
  material: string | null,
): Promise<{ fileId: number; opticModel: string } | null> {
  const canonical = await resolveCanonicalOptic(db, optic);

  // Fast path: exact (case-insensitive) match on optic model.
  const exact = await db
    .select()
    .from(partVariants)
    .where(and(eq(partVariants.partType, partType), ilike(partVariants.opticModel, canonical)));

  let candidates = exact;
  if (candidates.length === 0) {
    // Fallback: normalized comparison in JS across this part type. Absorbs
    // spelling drift not yet captured in optic_aliases.
    const all = await db.select().from(partVariants).where(eq(partVariants.partType, partType));
    const target = normalizeOptic(canonical);
    candidates = all.filter((v) => normalizeOptic(v.opticModel) === target);
  }
  if (candidates.length === 0) return null;

  // Prefer a material-specific variant, else a material-agnostic (null) one.
  let chosen: (typeof candidates)[number] | undefined;
  if (material) {
    chosen = candidates.find(
      (v) => v.material && normalizeValue(v.material) === normalizeValue(material),
    );
  }
  chosen ??= candidates.find((v) => !v.material) ?? candidates[0];
  return { fileId: chosen.fileId, opticModel: chosen.opticModel };
}

async function findFilament(db: Database, material: string | null, color: string | null) {
  if (!material || !color) return null;
  const [row] = await db
    .select()
    .from(filamentMap)
    .where(
      and(
        ilike(filamentMap.materialOption, material),
        ilike(filamentMap.colorOption, color),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Top-level resolution
// ---------------------------------------------------------------------------

export async function resolveLineItem(
  db: Database,
  rawRuleSet: unknown,
  lineItem: LineItemInput,
): Promise<ResolveResult> {
  const ruleSet = ruleSetSchema.parse(rawRuleSet);
  const ctx = extractContext(ruleSet, lineItem);
  // Apply opt-in per-product defaults only where detection came up empty.
  const material = ctx.material ?? ruleSet.defaultMaterial ?? null;
  const color = ctx.color ?? ruleSet.defaultColor ?? null;
  const extracted = { material, color, optic: ctx.optic };

  const { printed, hardware, matchedAnyRule } = matchRules(ruleSet, ctx.valuePool);

  const bom: ResolvedBom[] = [];
  for (const h of hardware) {
    bom.push({ kind: "hardware", ref: h.ref, quantity: h.perUnit * lineItem.quantity });
  }

  if (!matchedAnyRule) {
    return {
      jobs: [
        {
          partType: "(no BOM rule)",
          opticModel: ctx.optic,
          printableFileId: null,
          quantity: lineItem.quantity,
          materialOption: material,
          colorOption: color,
          filamentMaterial: null,
          colorHex: null,
          slicerProfile: null,
          status: "needs_review",
          reviewReason: `No BOM rule matched options (variant: ${lineItem.variantTitle ?? "-"})`,
          reviewKind: "no_bom_rule",
        },
      ],
      bom,
      resolutionStatus: "needs_review",
      extracted,
    };
  }

  const jobs: ResolvedJob[] = [];
  const filament = await findFilament(db, material, color);

  for (const part of printed) {
    bom.push({ kind: "printed", ref: part.partType, quantity: part.perUnit * lineItem.quantity });

    // Model file is optional enrichment: attach it when we can resolve it, but
    // never let a missing file block the job from being plate-ready.
    const opticForPart = part.fixedOptic ?? ctx.optic;
    let printableFileId: number | null = null;
    let opticModel: string | null = opticForPart;
    if (opticForPart) {
      const match = await findPrintableFile(db, part.partType, opticForPart, material);
      if (match) {
        printableFileId = match.fileId;
        opticModel = match.opticModel;
      }
    }

    // Ready-gate: a job can go on a plate as soon as its filament (material +
    // color) is known. Filament map + model file are enrichment only.
    const missing: string[] = [];
    if (!material) missing.push("material");
    if (!color) missing.push("color");
    const ready = missing.length === 0;

    jobs.push({
      partType: part.partType,
      opticModel,
      printableFileId,
      quantity: part.perUnit * lineItem.quantity,
      materialOption: material,
      colorOption: color,
      filamentMaterial: filament?.filamentMaterial ?? null,
      colorHex: filament?.colorHex ?? null,
      slicerProfile: filament?.slicerProfile ?? null,
      status: ready ? "ready" : "needs_review",
      reviewReason: ready ? null : `filament unknown (${missing.join(" + ")} not detected)`,
      reviewKind: ready ? null : "filament_unknown",
    });
  }

  const resolutionStatus = jobs.every((j) => j.status === "ready") ? "resolved" : "needs_review";
  return { jobs, bom, resolutionStatus, extracted };
}
