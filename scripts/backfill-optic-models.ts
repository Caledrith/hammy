/**
 * Backfill printJobs.opticModel for jobs that resolved before the engine learned
 * to read model-bearing property keys (Flashlight, Silencer Model, Model, ...).
 *
 * Recomputes the optic per line item with the current engine + the line item's
 * actual recipe, then fills ONLY jobs whose opticModel is still null. Job status
 * (ready / printing / done) is preserved — this never deletes or re-resolves.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-optic-models.ts            # preview
 *   npx tsx scripts/backfill-optic-models.ts --apply    # write
 */
import "dotenv/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { orderLineItems, printJobs, productRecipes } from "../src/db/schema";
import { extractContext } from "../src/lib/recipes/engine";
import { DEFAULT_RULESET, ruleSetSchema, type LineItemInput } from "../src/lib/recipes/types";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = getDb();

  // Recipes indexed by key for fast per-line-item lookup.
  const recipes = await db.select().from(productRecipes);
  const recipeByKey = new Map(recipes.map((r) => [r.key, r]));

  // Line items that still have at least one optic-less job.
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
    .innerJoin(printJobs, eq(printJobs.orderLineItemId, orderLineItems.id))
    .where(isNull(printJobs.opticModel));

  console.log(`line items with optic-less job(s): ${lineItems.length}`);

  let lineItemsFilled = 0;
  let jobsUpdated = 0;
  const samples: string[] = [];

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
    if (!optic) continue;

    lineItemsFilled += 1;
    if (samples.length < 25) {
      samples.push(`  li${li.id} (${li.productHandle ?? "?"}) -> ${optic}`);
    }

    if (APPLY) {
      const res = await db
        .update(printJobs)
        .set({ opticModel: optic, updatedAt: new Date() })
        .where(and(eq(printJobs.orderLineItemId, li.id), isNull(printJobs.opticModel)))
        .returning({ id: printJobs.id });
      jobsUpdated += res.length;
    } else {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(printJobs)
        .where(and(eq(printJobs.orderLineItemId, li.id), isNull(printJobs.opticModel)));
      jobsUpdated += n;
    }
  }

  console.log(`\nline items that gained a model: ${lineItemsFilled}`);
  console.log(`${APPLY ? "jobs updated" : "jobs that would update"}: ${jobsUpdated}`);
  if (samples.length) {
    console.log("\nsamples:");
    for (const s of samples) console.log(s);
  }
  if (!APPLY) console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
