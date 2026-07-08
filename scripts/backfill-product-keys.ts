import "dotenv/config";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { orderLineItems, orders, printJobs } from "../src/db/schema";
import type { Channel } from "../src/lib/channels/types";
import { resolveProductKey } from "../src/lib/ingest";

/**
 * Backfill the two columns added for the product-centric review page:
 *   - order_line_items.product_key (resolved product identity)
 *   - print_jobs.review_kind (structured classification from legacy free text)
 *
 * Safe to re-run: only touches rows whose product_key is still null and re-tags
 * needs_review jobs from their existing review_reason text.
 */
async function main() {
  const db = getDb();

  const rows = await db
    .select({
      id: orderLineItems.id,
      productHandle: orderLineItems.productHandle,
      sku: orderLineItems.sku,
      channel: orders.channel,
    })
    .from(orderLineItems)
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(isNull(orderLineItems.productKey));

  console.log(`Backfilling product_key for ${rows.length} line item(s)...`);

  let done = 0;
  for (const row of rows) {
    const productKey = await resolveProductKey(
      db,
      (row.channel ?? "shopify") as Channel,
      row.productHandle,
      row.sku,
    );
    await db
      .update(orderLineItems)
      .set({ productKey })
      .where(eq(orderLineItems.id, row.id));
    done += 1;
    if (done % 50 === 0) console.log(`  ...${done}/${rows.length}`);
  }

  console.log("\nBackfilling print_jobs.review_kind from legacy review_reason text...");
  await db
    .update(printJobs)
    .set({ reviewKind: "no_bom_rule" })
    .where(and(eq(printJobs.status, "needs_review"), ilike(printJobs.reviewReason, "No BOM rule%")));
  await db
    .update(printJobs)
    .set({ reviewKind: "filament_unknown" })
    .where(
      and(eq(printJobs.status, "needs_review"), ilike(printJobs.reviewReason, "filament unknown%")),
    );

  const kinds = await db
    .select({ kind: printJobs.reviewKind, count: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(eq(printJobs.status, "needs_review"))
    .groupBy(printJobs.reviewKind);
  const withKey = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orderLineItems)
    .where(sql`${orderLineItems.productKey} is not null`);

  console.log(`\nDone. Backfilled product_key for ${done} line item(s).`);
  console.log(`Line items with a product_key: ${withKey[0]?.count ?? 0}`);
  console.log("needs_review jobs by review_kind:");
  for (const r of kinds) console.log(`  ${(r.kind ?? "(null)").padEnd(16)} ${r.count}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nbackfill-product-keys failed:\n", err);
    process.exit(1);
  });
