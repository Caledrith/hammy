import "dotenv/config";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { orderLineItems, printJobs } from "../src/db/schema";
import { reprocessLineItem } from "../src/lib/ingest";

/**
 * Re-run resolution for already-ingested line items so new engine semantics /
 * recipes / filament seeds take effect without re-syncing from the channel.
 *
 * By default it skips any line item whose jobs an operator has already acted on
 * (assigned/printing/done/failed/cancelled) so manual work is preserved. Pass
 * `--all` to reprocess everything.
 */
const PROTECTED_STATUSES = ["assigned", "printing", "done", "failed", "cancelled"] as const;

async function main() {
  const all = process.argv.includes("--all");
  const db = getDb();

  // Line items that currently have jobs (candidates for reprocessing).
  const withJobs = await db
    .selectDistinct({ id: printJobs.orderLineItemId })
    .from(printJobs);
  let candidateIds = withJobs.map((r) => r.id);

  if (!all && candidateIds.length > 0) {
    const protectedRows = await db
      .selectDistinct({ id: printJobs.orderLineItemId })
      .from(printJobs)
      .where(inArray(printJobs.status, [...PROTECTED_STATUSES]));
    const protectedSet = new Set(protectedRows.map((r) => r.id));
    candidateIds = candidateIds.filter((id) => !protectedSet.has(id));
  }

  console.log(
    `Reprocessing ${candidateIds.length} line items${all ? " (--all)" : " (skipping operator-touched jobs)"}...`,
  );

  let done = 0;
  for (const id of candidateIds) {
    await reprocessLineItem(id);
    done += 1;
    if (done % 50 === 0) console.log(`  ...${done}/${candidateIds.length}`);
  }

  const byStatus = await db
    .select({ status: printJobs.status, count: sql<number>`count(*)::int` })
    .from(printJobs)
    .groupBy(printJobs.status);
  const liByStatus = await db
    .select({ status: orderLineItems.resolutionStatus, count: sql<number>`count(*)::int` })
    .from(orderLineItems)
    .groupBy(orderLineItems.resolutionStatus);

  console.log(`\nDone. Reprocessed ${done} line items.`);
  console.log("Jobs by status:");
  for (const r of byStatus) console.log(`  ${r.status.padEnd(14)} ${r.count}`);
  console.log("Line items by resolution:");
  for (const r of liByStatus) console.log(`  ${r.status.padEnd(14)} ${r.count}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nreresolve failed:\n", err);
    process.exit(1);
  });
