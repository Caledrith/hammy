/**
 * Reconcile printJobs.opticModel with the current engine, in place.
 *
 * Recomputes the optic per line item (using its actual recipe) and:
 *   - FILLS jobs whose opticModel is null but the engine now finds a model
 *     (e.g. flashlight/silencer models).
 *   - CLEARS jobs whose stored opticModel is junk the old "leftover" heuristic
 *     grabbed from an option field ("5 Mags", "Non-metal", "No Ridge", ...) —
 *     i.e. the engine now yields no model for that line item.
 * A non-null model that the engine still recognizes is left untouched, so
 * catalog-canonicalized optics (via part_variants) are preserved.
 *
 * Job status (ready / printing / done) is never changed.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-optic-models.ts            # preview
 *   npx tsx scripts/backfill-optic-models.ts --apply    # write
 */
import "dotenv/config";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { orderLineItems, printJobs, productRecipes } from "../src/db/schema";
import { extractContext } from "../src/lib/recipes/engine";
import { DEFAULT_RULESET, ruleSetSchema, type LineItemInput } from "../src/lib/recipes/types";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = getDb();

  const recipes = await db.select().from(productRecipes);
  const recipeByKey = new Map(recipes.map((r) => [r.key, r]));

  // Every line item that has at least one print job.
  const lineItems = await db
    .selectDistinct({
      id: orderLineItems.id,
      productKey: orderLineItems.productKey,
      productHandle: orderLineItems.productHandle,
      sku: orderLineItems.sku,
      variantTitle: orderLineItems.variantTitle,
      quantity: orderLineItems.quantity,
      properties: orderLineItems.properties,
    })
    .from(orderLineItems)
    .innerJoin(printJobs, eq(printJobs.orderLineItemId, orderLineItems.id));

  console.log(`line items with print job(s): ${lineItems.length}`);

  let filledJobs = 0;
  let clearedJobs = 0;
  const fillSamples: string[] = [];
  const clearSamples: string[] = [];

  for (const li of lineItems) {
    const keys = [li.productKey, li.productHandle, li.sku].filter((v): v is string => !!v);
    const recipe = keys.map((k) => recipeByKey.get(k)).find(Boolean);
    const ruleSet = recipe ? ruleSetSchema.parse(recipe.ruleSet) : DEFAULT_RULESET;

    const input: LineItemInput = {
      productHandle: li.productHandle,
      sku: li.sku,
      variantTitle: li.variantTitle,
      quantity: li.quantity,
      properties: li.properties ?? [],
    };
    const { optic } = extractContext(ruleSet, input);

    if (optic) {
      // FILL: jobs with no model get the freshly-found one.
      const target = db
        .select({ id: printJobs.id, cur: printJobs.opticModel })
        .from(printJobs)
        .where(and(eq(printJobs.orderLineItemId, li.id), isNull(printJobs.opticModel)));
      const rows = await target;
      if (rows.length) {
        if (fillSamples.length < 15)
          fillSamples.push(`  li${li.id} (${li.productHandle ?? "?"}) -> ${optic}`);
        if (APPLY) {
          await db
            .update(printJobs)
            .set({ opticModel: optic, updatedAt: new Date() })
            .where(and(eq(printJobs.orderLineItemId, li.id), isNull(printJobs.opticModel)));
        }
        filledJobs += rows.length;
      }
    } else {
      // CLEAR: stored model is junk the engine no longer recognizes.
      const rows = await db
        .select({ id: printJobs.id, cur: printJobs.opticModel })
        .from(printJobs)
        .where(and(eq(printJobs.orderLineItemId, li.id), isNotNull(printJobs.opticModel)));
      if (rows.length) {
        if (clearSamples.length < 15)
          clearSamples.push(`  li${li.id} (${li.productHandle ?? "?"}) x-${rows[0].cur}`);
        if (APPLY) {
          await db
            .update(printJobs)
            .set({ opticModel: null, updatedAt: new Date() })
            .where(and(eq(printJobs.orderLineItemId, li.id), isNotNull(printJobs.opticModel)));
        }
        clearedJobs += rows.length;
      }
    }
  }

  console.log(`\n${APPLY ? "filled" : "would fill"} jobs:   ${filledJobs}`);
  console.log(`${APPLY ? "cleared" : "would clear"} jobs:  ${clearedJobs}`);
  if (fillSamples.length) {
    console.log("\nfill samples:");
    for (const s of fillSamples) console.log(s);
  }
  if (clearSamples.length) {
    console.log("\nclear samples (junk optics removed):");
    for (const s of clearSamples) console.log(s);
  }
  if (!APPLY) console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
