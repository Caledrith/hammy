import "dotenv/config";
import { desc, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { orderLineItems, printJobs } from "../src/db/schema";

/** Print a quick breakdown of the print-job queue for verification / ops. */
async function main() {
  const db = getDb();

  const byStatus = await db
    .select({ status: printJobs.status, count: sql<number>`count(*)::int` })
    .from(printJobs)
    .groupBy(printJobs.status)
    .orderBy(desc(sql`count(*)`));
  console.log("Print jobs by status:");
  for (const r of byStatus) console.log(`  ${r.status.padEnd(14)} ${r.count}`);

  const liByStatus = await db
    .select({ status: orderLineItems.resolutionStatus, count: sql<number>`count(*)::int` })
    .from(orderLineItems)
    .groupBy(orderLineItems.resolutionStatus);
  console.log("\nLine items by resolution:");
  for (const r of liByStatus) console.log(`  ${r.status.padEnd(14)} ${r.count}`);

  const reasons = await db
    .select({ reason: printJobs.reviewReason, count: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(sql`${printJobs.status} = 'needs_review'`)
    .groupBy(printJobs.reviewReason)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  console.log("\nTop needs_review reasons:");
  for (const r of reasons) console.log(`  [${r.count}] ${r.reason ?? "(none)"}`);

  const ready = await db
    .select({
      id: printJobs.id,
      partType: printJobs.partType,
      optic: printJobs.opticModel,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      profile: printJobs.slicerProfile,
      qty: printJobs.quantity,
    })
    .from(printJobs)
    .where(sql`${printJobs.status} = 'ready'`)
    .limit(15);
  console.log(`\nReady jobs (${ready.length} shown):`);
  for (const j of ready) {
    console.log(
      `  #${j.id} ${j.partType} | ${j.optic ?? "-"} | ${j.material ?? "-"}/${j.color ?? "-"} | ${j.profile ?? "-"} | x${j.qty}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
