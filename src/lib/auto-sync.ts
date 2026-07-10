import { runSyncOnce } from "./sync-runner";

/**
 * Background autosync. Started once from instrumentation when the server boots
 * and pulls new Shopify orders on a fixed interval so the queue stays current
 * without anyone clicking "Sync now".
 *
 * Interval is configurable via SYNC_INTERVAL_MINUTES (default 5). Set it to 0 to
 * disable the scheduler (e.g. when driving syncs from an external cron).
 */
const DEFAULT_INTERVAL_MINUTES = 5;
const BOOT_DELAY_MS = 15_000;

let started = false;

export function startAutoSync(): void {
  if (started) return;
  started = true;

  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[auto-sync] disabled (SYNC_INTERVAL_MINUTES <= 0)");
    return;
  }

  const intervalMs = minutes * 60_000;
  console.log(`[auto-sync] enabled: syncing every ${minutes} min`);

  const tick = async (): Promise<void> => {
    try {
      const { result, coalesced } = await runSyncOnce();
      if (coalesced) return;
      console.log(
        `[auto-sync] ${new Date().toISOString()} ` +
          `orders=${result.ordersProcessed} jobs=${result.jobsCreated} ` +
          `review=${result.needsReview} cancelled=${result.cancelledJobs}`,
      );
    } catch (err) {
      console.error("[auto-sync] failed:", err instanceof Error ? err.message : err);
    }
  };

  // First pass shortly after boot, then on the interval.
  setTimeout(tick, BOOT_DELAY_MS);
  const timer = setInterval(tick, intervalMs);
  // Don't let the timer alone keep the process alive; the server already does.
  timer.unref?.();
}
