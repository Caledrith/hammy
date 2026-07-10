"use client";

import { useEffect, useState } from "react";

/** Human "3m ago" style age from an ISO timestamp. */
function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Shows when orders were last synced and the autosync cadence. The relative
 * label is computed on the client (and re-ticked) to avoid SSR/hydration drift.
 */
export function SyncStatus({
  lastSyncedIso,
  intervalMinutes,
}: {
  lastSyncedIso: string | null;
  intervalMinutes: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const cadence = intervalMinutes > 0 ? `auto every ${intervalMinutes}m` : "auto off";
  return (
    <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} suppressHydrationWarning>
      {cadence}
      {lastSyncedIso ? ` · synced ${ago(lastSyncedIso)}` : ""}
    </span>
  );
}
