import "dotenv/config";
import { syncOrders } from "../src/lib/ingest";

/**
 * Pull orders from Shopify into the print-job queue. Idempotent and safe to
 * re-run (or run on a cron). Pass `--full` to ignore the saved sync cursor and
 * re-scan recent orders.
 */
function parseDays(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--days="));
  if (!arg) return undefined;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  const full = process.argv.includes("--full");
  const days = parseDays();
  const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;
  const scope = full ? "full re-scan" : since ? `last ${days}d` : "incremental";
  console.log(`Syncing orders (${scope})...`);
  const result = await syncOrders({ full, since });
  console.log("\nSync complete:");
  console.log(`  orders processed:   ${result.ordersProcessed}`);
  console.log(`  line items resolved:${result.lineItemsResolved}`);
  console.log(`  jobs created:       ${result.jobsCreated}`);
  console.log(`  needs review:       ${result.needsReview}`);
  console.log(`  jobs cancelled:     ${result.cancelledJobs}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nsync-orders failed:\n", err);
    process.exit(1);
  });
