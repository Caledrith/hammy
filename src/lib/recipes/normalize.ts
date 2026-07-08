/**
 * Normalize an optic (scope model) string for fuzzy matching between Shopify
 * option strings and the model-file library / aliases.
 *
 * Lowercases, unifies the "x" magnification separator, strips punctuation, and
 * collapses whitespace. Deliberately conservative: it does NOT try to translate
 * roman numerals or brand abbreviations - those differences are absorbed by the
 * `optic_aliases` table (populated when a human resolves a needs_review job).
 */
export function normalizeOptic(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[×✕✖]/g, "x")
    .replace(/[^a-z0-9x]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case/space-insensitive comparison for option values. */
export function normalizeValue(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Collapse the materials the shop actually stocks down to the canonical set used
 * everywhere (catalog dropdown, plate grouping, print jobs): PLA+, PETG-CF, MJF
 * Nylon. The store sells only the "+" / "-CF" grades, so a plain "PLA" or "PETG"
 * detected from order text is really PLA+ / PETG-CF, and any "Nylon" is MJF Nylon.
 * Keyed by normalizeValue() output.
 */
const MATERIAL_ALIASES: Record<string, string> = {
  pla: "PLA+",
  "pla+": "PLA+",
  petg: "PETG-CF",
  "petg-cf": "PETG-CF",
  "petg cf": "PETG-CF",
  nylon: "MJF Nylon",
  "mjf nylon": "MJF Nylon",
};

/**
 * Map a detected/raw material string to the canonical material, or return it
 * unchanged (trimmed) when there's no alias. `null`/empty passes through as null.
 */
export function canonicalizeMaterial(material: string | null): string | null {
  if (!material) return null;
  const key = normalizeValue(material);
  return MATERIAL_ALIASES[key] ?? material.trim();
}
