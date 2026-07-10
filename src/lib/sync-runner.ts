import { syncOrders, type SyncResult } from "./ingest";

/**
 * Single in-process gate around order syncing. The manual "Sync now" button and
 * the background autosync both call through here, so a click during a scheduled
 * run (or vice-versa) coalesces onto the one in-flight sync instead of running
 * two overlapping passes against Shopify + the DB.
 */
let inFlight: Promise<SyncResult> | null = null;
let lastRunAt: Date | null = null;
let lastResult: SyncResult | null = null;
let lastError: string | null = null;

export interface RunSyncOutcome {
  result: SyncResult;
  /** True when this call joined an already-running sync instead of starting one. */
  coalesced: boolean;
}

export async function runSyncOnce(): Promise<RunSyncOutcome> {
  if (inFlight) {
    const result = await inFlight;
    return { result, coalesced: true };
  }
  inFlight = syncOrders();
  try {
    const result = await inFlight;
    lastResult = result;
    lastError = null;
    return { result, coalesced: false };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    lastRunAt = new Date();
    inFlight = null;
  }
}

export function isSyncing(): boolean {
  return inFlight !== null;
}

export function syncStatus(): {
  syncing: boolean;
  lastRunAt: Date | null;
  lastResult: SyncResult | null;
  lastError: string | null;
} {
  return { syncing: inFlight !== null, lastRunAt, lastResult, lastError };
}
