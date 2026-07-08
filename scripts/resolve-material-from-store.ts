import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { filamentMap, orderLineItems, printJobs, productRecipes } from "../src/db/schema";
import { needsReviewLineItemIdsForProduct, reprocessLineItems } from "../src/lib/ingest";
import { DEFAULT_RULESET, ruleSetSchema } from "../src/lib/recipes/types";

/**
 * Resolve "filament_unknown" reviews caused by a MISSING MATERIAL. These products
 * are sold in a single fixed material that only appears in the store's product
 * description (e.g. "MATERIAL: 3D printed using PETG-CF filament"), never in the
 * order. We read the store product JSON, parse the material, and set the
 * product's recipe defaultMaterial. Color is left to the engine's per-order
 * detection (defaultColor is intentionally NOT set here), so multi-color
 * products still resolve per variant and genuinely color-less ones stay in
 * review for a separate pass.
 *
 * Dry-run by default. Pass --apply to write recipes + re-resolve.
 */
const APPLY = process.argv.includes("--apply");
const STORE = "https://hammy3dprints.com";

interface Probe {
  productKey: string;
  handle: string | null;
  title: string | null;
  jobs: number;
}

function parseMaterial(bodyHtml: string, known: string[]): string | null {
  const m = bodyHtml.match(/MATERIAL:[^.<]*?\b([A-Za-z0-9+]+(?:-[A-Za-z0-9]+)?)\s*filament/i);
  if (!m) return null;
  const raw = m[1].trim();
  return known.find((k) => k.toLowerCase() === raw.toLowerCase()) ?? null;
}

async function fetchProductBody(handle: string): Promise<string | null> {
  const res = await fetch(`${STORE}/products/${handle}.json`);
  if (!res.ok) return null;
  const json = (await res.json()) as { product?: { body_html?: string } };
  return json.product?.body_html ?? null;
}

async function main() {
  const db = getDb();

  const knownMaterials = [
    ...new Set(
      (await db.select({ m: filamentMap.materialOption }).from(filamentMap)).map((r) => r.m),
    ),
  ];

  const rows = await db
    .select({
      productKey: orderLineItems.productKey,
      handle: orderLineItems.productHandle,
      title: orderLineItems.title,
    })
    .from(printJobs)
    .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .where(
      and(
        eq(printJobs.status, "needs_review"),
        eq(printJobs.reviewKind, "filament_unknown"),
        isNotNull(orderLineItems.productKey),
      ),
    );

  const byProduct = new Map<string, Probe>();
  for (const r of rows) {
    const productKey = r.productKey as string;
    const p = byProduct.get(productKey) ?? {
      productKey,
      handle: r.handle,
      title: r.title,
      jobs: 0,
    };
    p.jobs += 1;
    byProduct.set(productKey, p);
  }

  const products = [...byProduct.values()].sort((a, b) => b.jobs - a.jobs);
  console.log(
    `${APPLY ? "APPLY" : "DRY-RUN"}: ${products.length} filament_unknown products; known materials: ${knownMaterials.join(", ")}\n`,
  );

  const resolved: { probe: Probe; material: string }[] = [];
  const unresolved: { probe: Probe; reason: string }[] = [];

  for (const p of products) {
    const handle = p.handle ?? p.productKey;
    let body: string | null = null;
    try {
      body = await fetchProductBody(handle);
    } catch (err) {
      unresolved.push({ probe: p, reason: `fetch error: ${(err as Error).message}` });
      continue;
    }
    if (body === null) {
      unresolved.push({ probe: p, reason: "store 404 / no body_html" });
      continue;
    }
    const material = parseMaterial(body, knownMaterials);
    if (!material) {
      unresolved.push({ probe: p, reason: "material not found in description" });
      continue;
    }
    resolved.push({ probe: p, material });
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`Parsed material for ${resolved.length}/${products.length} products:`);
  const byMaterial = new Map<string, number>();
  for (const { material } of resolved) byMaterial.set(material, (byMaterial.get(material) ?? 0) + 1);
  for (const [m, n] of [...byMaterial.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m.padEnd(10)} ${n} product(s)`);
  }

  if (unresolved.length) {
    console.log(`\nCould NOT parse material (${unresolved.length}) — need manual handling:`);
    for (const { probe, reason } of unresolved) {
      console.log(`  ${probe.title ?? probe.productKey}\n    ${probe.productKey} — ${reason}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to set defaultMaterial + re-resolve.`);
    return;
  }

  console.log(`\nApplying defaultMaterial to ${resolved.length} product recipes + re-resolving...`);
  let touched = 0;
  let reresolved = 0;
  for (const { probe, material } of resolved) {
    const key = probe.productKey;
    const [existing] = await db
      .select()
      .from(productRecipes)
      .where(eq(productRecipes.key, key))
      .limit(1);
    const base = existing ? ruleSetSchema.parse(existing.ruleSet) : DEFAULT_RULESET;
    const ruleSet = { ...base, defaultMaterial: material };
    const name = existing?.name ?? probe.title ?? key;
    await db
      .insert(productRecipes)
      .values({ key, name, ruleSet })
      .onConflictDoUpdate({
        target: productRecipes.key,
        set: { name, ruleSet, updatedAt: new Date() },
      });
    touched += 1;

    const ids = await needsReviewLineItemIdsForProduct(key);
    await reprocessLineItems(ids);
    reresolved += ids.length;
    if (touched % 20 === 0) console.log(`  ...${touched}/${resolved.length}`);
  }

  const remaining = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(and(eq(printJobs.status, "needs_review"), eq(printJobs.reviewKind, "filament_unknown")));
  console.log(
    `\nDone. Set material on ${touched} recipe(s), re-resolved ${reresolved} line item(s).`,
  );
  console.log(`Remaining filament_unknown jobs: ${remaining.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nresolve-material-from-store failed:\n", err);
    process.exit(1);
  });
