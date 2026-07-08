"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Sync trigger for the nav. Runs the sync via the /api/sync route (a plain fetch
 * the client controls) instead of a blocking server action, so the request no
 * longer holds the whole page render — and the Next dev indicator — pending for
 * the full multi-minute sync. Shows explicit progress and refreshes on success.
 */
export function SyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onSync() {
    if (syncing) return;
    setError(null);
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `Sync failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const busy = syncing || isPending;
  const label = syncing ? "Syncing…" : isPending ? "Refreshing…" : "Sync now";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {error ? (
        <span className="reason" title={error}>
          sync failed
        </span>
      ) : null}
      <button type="button" className="primary" onClick={onSync} disabled={busy}>
        {label}
      </button>
    </span>
  );
}
