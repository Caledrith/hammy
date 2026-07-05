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
