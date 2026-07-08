import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { filamentMap, orderLineItems, printJobs } from "../src/db/schema";

/**
 * Read-only inspection of what is stuck in needs_review, grouped by product +
 * review kind, plus the filament palette and a store-connectivity probe. Helps
 * design the store-lookup filament resolver. Modifies nothing.
 */
async function main() {
  const db = getDb();

  const rows = await db
    .select({
      productKey: orderLineItems.productKey,
      handle: orderLineItems.productHandle,
      sku: orderLineItems.sku,
      title: orderLineItems.title,
      variant: orderLineItems.variantTitle,
      kind: printJobs.reviewKind,
      jobId: printJobs.id,
      orderId: orderLineItems.orderId,
    })
    .from(printJobs)
    .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .where(eq(printJobs.status, "needs_review"));

  interface Agg {
    productKey: string;
    handle: string | null;
    title: string | null;
    kind: string;
    jobs: number;
    orders: Set<number>;
    variants: Set<string>;
  }
  const groups = new Map<string, Agg>();
  for (const r of rows) {
    const productKey = r.productKey ?? r.handle ?? r.sku ?? "unknown";
    const kind = r.kind ?? "other";
    const key = `${productKey}||${kind}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        productKey,
        handle: r.handle,
        title: r.title,
        kind,
        jobs: 0,
        orders: new Set(),
        variants: new Set(),
      };
      groups.set(key, g);
    }
    g.jobs += 1;
    if (r.orderId) g.orders.add(r.orderId);
    if (r.variant) g.variants.add(r.variant);
  }

  const list = [...groups.values()].sort((a, b) => b.jobs - a.jobs);
  const byKind = new Map<string, number>();
  for (const g of list) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);

  console.log(`needs_review jobs: ${rows.length} across ${list.length} product/kind groups\n`);
  console.log("Groups by review kind:");
  for (const [k, n] of byKind) console.log(`  ${k.padEnd(16)} ${n} product group(s)`);

  console.log("\nProduct groups (desc by job count):");
  for (const g of list) {
    console.log(
      `\n  [${g.kind}] ${g.title ?? g.productKey}\n    key: ${g.productKey}\n    handle: ${g.handle ?? "-"}\n    ${g.jobs} job(s), ${g.orders.size} order(s)\n    variants: ${[...g.variants].join(" | ") || "-"}`,
    );
  }

  const fm = await db
    .select({ material: filamentMap.materialOption, color: filamentMap.colorOption })
    .from(filamentMap);
  const materials = [...new Set(fm.map((f) => f.material))].sort();
  const colors = [...new Set(fm.map((f) => f.color))].sort();
  console.log(`\nFilament palette: ${fm.length} (material,color) rows`);
  console.log(`  materials: ${materials.join(", ")}`);
  console.log(`  colors: ${colors.join(", ")}`);

  const probeHandle = list.find((g) => g.kind === "filament_unknown")?.productKey;
  if (probeHandle) {
    const url = `https://hammy3dprints.com/products/${probeHandle}.json`;
    console.log(`\nStore connectivity probe: ${url}`);
    try {
      const res = await fetch(url);
      console.log(`  HTTP ${res.status}`);
      if (res.ok) {
        const json = (await res.json()) as { product?: { body_html?: string; options?: unknown } };
        const body = json.product?.body_html ?? "";
        const m = body.match(/MATERIAL:[^.<]*?\b([A-Za-z0-9+]+(?:-[A-Za-z0-9]+)?)\s*filament/i);
        console.log(`  parsed material: ${m?.[1] ?? "(none found)"}`);
        console.log(`  options: ${JSON.stringify(json.product?.options)}`);
      }
    } catch (err) {
      console.log(`  fetch FAILED: ${(err as Error).message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\ninspect-review-products failed:\n", err);
    process.exit(1);
  });
