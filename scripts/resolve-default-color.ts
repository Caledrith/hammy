import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { filamentMap, orderLineItems, printJobs, productRecipes } from "../src/db/schema";
import { needsReviewLineItemIdsForProduct, reprocessLineItems } from "../src/lib/ingest";
import { ruleSetSchema } from "../src/lib/recipes/types";

/**
 * Second pass for filament_unknown reviews: products whose order carries NO
 * color (variants are style/size only, e.g. "Default Title", "Two-Piece").
 * These are single-color products, so we set the recipe defaultColor.
 *
 * Only products that ALREADY have a defaultMaterial (from resolve-material-from-
 * store) are touched, so material-unknown items (e.g. the sticker) are left
 * alone instead of being half-configured. Dry-run by default; --apply to write.
 * Color via --color=<Name> (default Black).
 */
const APPLY = process.argv.includes("--apply");
const colorArg = process.argv.find((a) => a.startsWith("--color="));
const COLOR = colorArg ? colorArg.slice("--color=".length) : "Black";

async function main() {
  const db = getDb();

  const rows = await db
    .select({ productKey: orderLineItems.productKey, title: orderLineItems.title })
    .from(printJobs)
    .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .where(
      and(
        eq(printJobs.status, "needs_review"),
        eq(printJobs.reviewKind, "filament_unknown"),
        isNotNull(orderLineItems.productKey),
      ),
    );
  const keyed = new Map<string, string | null>();
  for (const r of rows) keyed.set(r.productKey as string, r.title);

  const eligible: { key: string; title: string | null; material: string; ruleSet: ReturnType<typeof ruleSetSchema.parse> }[] = [];
  const skipped: { key: string; title: string | null; reason: string }[] = [];

  for (const [key, title] of keyed) {
    const [recipe] = await db
      .select()
      .from(productRecipes)
      .where(eq(productRecipes.key, key))
      .limit(1);
    if (!recipe) {
      skipped.push({ key, title, reason: "no recipe (material unknown)" });
      continue;
    }
    const ruleSet = ruleSetSchema.parse(recipe.ruleSet);
    if (!ruleSet.defaultMaterial) {
      skipped.push({ key, title, reason: "recipe has no defaultMaterial" });
      continue;
    }
    const [fm] = await db
      .select({ id: filamentMap.id })
      .from(filamentMap)
      .where(
        and(
          eq(filamentMap.materialOption, ruleSet.defaultMaterial),
          eq(filamentMap.colorOption, COLOR),
        ),
      )
      .limit(1);
    if (!fm) {
      skipped.push({ key, title, reason: `no filament_map row for ${ruleSet.defaultMaterial}/${COLOR}` });
      continue;
    }
    eligible.push({ key, title, material: ruleSet.defaultMaterial, ruleSet });
  }

  console.log(
    `${APPLY ? "APPLY" : "DRY-RUN"}: defaultColor=${COLOR}; eligible ${eligible.length}, skipped ${skipped.length}\n`,
  );
  for (const e of eligible) console.log(`  ${e.material.padEnd(10)} / ${COLOR}   ${e.title ?? e.key}`);
  if (skipped.length) {
    console.log("\nSkipped (left in review):");
    for (const s of skipped) console.log(`  ${s.title ?? s.key} — ${s.reason}`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to set defaultColor + re-resolve.");
    return;
  }

  let reresolved = 0;
  for (const e of eligible) {
    const ruleSet = { ...e.ruleSet, defaultColor: COLOR };
    await db
      .update(productRecipes)
      .set({ ruleSet, updatedAt: new Date() })
      .where(eq(productRecipes.key, e.key));
    const ids = await needsReviewLineItemIdsForProduct(e.key);
    await reprocessLineItems(ids);
    reresolved += ids.length;
  }

  const remaining = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(and(eq(printJobs.status, "needs_review"), eq(printJobs.reviewKind, "filament_unknown")));
  console.log(
    `\nDone. Set color on ${eligible.length} recipe(s), re-resolved ${reresolved} line item(s).`,
  );
  console.log(`Remaining filament_unknown jobs: ${remaining.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nresolve-default-color failed:\n", err);
    process.exit(1);
  });
