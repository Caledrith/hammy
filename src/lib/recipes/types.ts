import { z } from "zod";

/**
 * A recipe's rule set turns Shopify option values into a Bill of Materials.
 *
 * - `optionSelectors` maps a canonical option name (e.g. "optic") to the list of
 *   candidate source names to look for in line-item properties / custom attributes
 *   (e.g. ["Optic", "Scope", "Optic Model"]).
 * - `rules` are additive: every rule whose `when` matches contributes its printed
 *   parts and hardware to the BOM.
 */

export const printedPartSchema = z.object({
  partType: z.string().min(1),
  /**
   * For parts that are NOT optic-specific (e.g. a universal Tip Grip clamp),
   * pin the optic model to use for the model-file lookup (e.g. "Universal").
   * When omitted, the optic extracted from the order is used.
   */
  fixedOptic: z.string().optional(),
  /** Units of this part per ordered unit (default 1). */
  perUnit: z.number().int().positive().optional(),
});

export const hardwareSchema = z.object({
  ref: z.string().min(1),
  perUnit: z.number().int().positive().optional(),
});

export const bomRuleSchema = z.object({
  /** Optional human label for debugging. */
  label: z.string().optional(),
  /**
   * Conditions: canonical option name -> required value(s). A condition is met if
   * any required value is present in the line item's value pool (option values +
   * variant-title tokens), case-insensitively. All conditions must be met.
   * An empty/absent `when` always matches (useful for a base rule).
   */
  when: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  printed: z.array(printedPartSchema).optional(),
  hardware: z.array(hardwareSchema).optional(),
});

/**
 * How to locate the optic (scope model) string. In the live data the model is
 * stored under a property key named after the manufacturer (e.g. "Vector",
 * "Sig Sauer Optic"), so a fixed key lookup is not enough.
 */
export const opticStrategySchema = z.object({
  /** Explicit property keys to try first (exact or prefix match). */
  candidates: z.array(z.string()).optional(),
  /** Property keys that hold the manufacturer name (e.g. "Scope Manufacturer"). */
  manufacturerKeys: z.array(z.string()).optional(),
  /**
   * Property keys to ignore in the leftover-heuristic fallback (meta fields that
   * are not the optic model, e.g. "Color", "Lens To Cover", "Hex Style").
   */
  excludeKeys: z.array(z.string()).optional(),
});

/**
 * Canonical color names the engine recognizes when scanning variant tokens and
 * property values. Matching is longest-phrase-first (so "Earth Brown" beats
 * "Brown", "Olive Green" beats "Green") and returns the vocabulary's casing, so
 * the same physical filament always lands in one plate group regardless of how
 * the order phrased it. Keep aligned with the seeded filament palette so
 * detected colors also pick up a swatch hex / slicer profile.
 */
export const DEFAULT_COLOR_VOCAB: string[] = [
  "Matte Black",
  "Gunmetal Gray",
  "Coyote Brown",
  "Coyote Tan",
  "Earth Brown",
  "Light Brown",
  "Dark Brown",
  "Olive Green",
  "Army Green",
  "Forest Green",
  "Sage Green",
  "OD Green",
  "Navy Blue",
  "Sky Blue",
  "Flat Dark Earth",
  "Light Gray",
  "Dark Gray",
  "FDE",
  "Tan",
  "Black",
  "White",
  "Gray",
  "Grey",
  "Silver",
  "Gold",
  "Bronze",
  "Copper",
  "Red",
  "Blue",
  "Green",
  "Orange",
  "Yellow",
  "Purple",
  "Pink",
  "Brown",
  "Natural",
  "Clear",
  "Beige",
];

export const ruleSetSchema = z.object({
  optionSelectors: z.record(z.string(), z.array(z.string())).default({}),
  optic: opticStrategySchema.optional(),
  /** Property keys (exact/prefix) that hold the color option. */
  colorKeys: z.array(z.string()).default(["Color"]),
  /** Canonical color names to detect within variant tokens / property values. */
  colorVocab: z.array(z.string()).default(DEFAULT_COLOR_VOCAB),
  /**
   * Opt-in per-product filament fallbacks. Applied ONLY when detection fails, so
   * an operator can promote a specific product to plate-ready by declaring its
   * material/color rather than the engine guessing globally. Absent by default.
   */
  defaultMaterial: z.string().optional(),
  defaultColor: z.string().optional(),
  /**
   * Material keywords to detect within variant-title tokens / properties. The
   * shop stocks only PLA+, PETG-CF and MJF Nylon, so we detect those plus the
   * bare "PLA"/"PETG"/"Nylon" spellings and canonicalize them downstream
   * (see canonicalizeMaterial).
   */
  materialKeywords: z
    .array(z.string())
    .default(["PETG-CF", "PETG", "PLA+", "PLA", "MJF Nylon", "Nylon"]),
  rules: z.array(bomRuleSchema).default([]),
});

export type OpticStrategy = z.infer<typeof opticStrategySchema>;

export type PrintedPart = z.infer<typeof printedPartSchema>;
export type Hardware = z.infer<typeof hardwareSchema>;
export type BomRule = z.infer<typeof bomRuleSchema>;
export type RuleSet = z.infer<typeof ruleSetSchema>;
/** Input shape (pre-defaults) for authoring recipes without restating defaults. */
export type RuleSetInput = z.input<typeof ruleSetSchema>;

/**
 * Fallback rule set for products that have no explicit recipe. The overwhelming
 * majority of the catalog is a single printed part whose material/color live in
 * the variant title (e.g. "PETG-CF Black / ...") or a Color property, so the
 * default emits one generic part and relies on the engine's material/color
 * detection. Explicit recipes (e.g. the multi-part lens cover) override this.
 */
export const DEFAULT_RULESET: RuleSet = ruleSetSchema.parse({
  rules: [{ label: "default single part", printed: [{ partType: "print" }] }],
});

/** Normalized line item shape the engine operates on (from Shopify or the DB). */
export interface LineItemInput {
  productHandle: string | null;
  sku: string | null;
  variantTitle: string | null;
  quantity: number;
  properties: { name: string; value: string }[];
}
