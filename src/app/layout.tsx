import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { syncState } from "@/db/schema";
import { SyncButton } from "./sync-button";
import { SyncStatus } from "./sync-status";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hammy Print Queue",
  description: "Shopify orders to 3D print job queue",
};

async function lastSyncedIso(): Promise<string | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select({ at: syncState.updatedAt })
      .from(syncState)
      .where(eq(syncState.key, "orders:shopify"))
      .limit(1);
    return row?.at ? new Date(row.at).toISOString() : null;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const syncedAt = await lastSyncedIso();
  const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 5);

  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <span className="brand">HAMMY</span>
          <Link href="/print">To print</Link>
          <Link href="/queue">Queue</Link>
          <Link href="/review">Review</Link>
          <Link href="/orders">Orders</Link>
          <span className="spacer" />
          <SyncStatus
            lastSyncedIso={syncedAt}
            intervalMinutes={Number.isFinite(intervalMinutes) ? intervalMinutes : 5}
          />
          <SyncButton />
        </nav>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
