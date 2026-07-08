import Link from "next/link";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { orderLineItems, orders, printJobs } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const db = getDb();

  const [jobRows, [orderCount], liRows, filamentRows] = await Promise.all([
    db
      .select({ status: printJobs.status, count: sql<number>`count(*)::int` })
      .from(printJobs)
      .groupBy(printJobs.status),
    db.select({ count: sql<number>`count(*)::int` }).from(orders),
    db
      .select({ status: orderLineItems.resolutionStatus, count: sql<number>`count(*)::int` })
      .from(orderLineItems)
      .groupBy(orderLineItems.resolutionStatus),
    db
      .select({
        material: printJobs.materialOption,
        color: printJobs.colorOption,
        hex: sql<string | null>`max(${printJobs.colorHex})`,
        units: sql<number>`sum(${printJobs.quantity})::int`,
      })
      .from(printJobs)
      .where(inArray(printJobs.status, ["ready", "assigned"]))
      .groupBy(printJobs.materialOption, printJobs.colorOption)
      .orderBy(sql`sum(${printJobs.quantity}) desc`),
  ]);

  const jobs = Object.fromEntries(jobRows.map((r) => [r.status, r.count]));
  const totalJobs = jobRows.reduce((a, r) => a + r.count, 0);
  const needsReview = jobs["needs_review"] ?? 0;
  const li = Object.fromEntries(liRows.map((r) => [r.status, r.count]));

  return (
    <>
      <h1>Print queue overview</h1>
      <p className="subtitle">Shopify orders resolved into print jobs.</p>

      <div className="cards">
        <div className="card">
          <div className="num">{orderCount?.count ?? 0}</div>
          <div className="label">Orders synced</div>
        </div>
        <div className="card">
          <div className="num">{totalJobs}</div>
          <div className="label">Print jobs</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: "var(--green)" }}>
            {jobs["ready"] ?? 0}
          </div>
          <div className="label">Ready</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: "var(--accent)" }}>
            {jobs["printing"] ?? 0}
          </div>
          <div className="label">On printer</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: "var(--amber)" }}>
            {needsReview}
          </div>
          <div className="label">Needs review</div>
        </div>
      </div>

      <div className="actions-row" style={{ marginBottom: 8 }}>
        <Link href="/print">
          <button className="primary">Open to-print list</button>
        </Link>
      </div>

      <h2>Ready by filament</h2>
      {filamentRows.length === 0 ? (
        <div className="empty">No ready jobs yet. Sync orders, then resolve any that need review.</div>
      ) : (
        <div className="cards">
          {filamentRows.slice(0, 12).map((f) => (
            <Link
              href="/print"
              className="card"
              key={`${f.material}||${f.color}`}
              style={{ display: "block" }}
            >
              <div className="num" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="swatch" style={{ background: f.hex ?? "transparent", width: 18, height: 18 }} />
                {f.units}
              </div>
              <div className="label">
                {f.material ?? "?"} · {f.color ?? "?"}
              </div>
            </Link>
          ))}
        </div>
      )}

      <h2>Jobs by status</h2>
      <div className="cards">
        {jobRows.length === 0 ? (
          <div className="empty">No jobs yet. Hit &quot;Sync now&quot; to pull orders.</div>
        ) : (
          jobRows.map((r) => (
            <div className="card" key={r.status}>
              <div className="num">{r.count}</div>
              <div className="label">
                <span className={`badge ${r.status}`}>{r.status}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <h2>Quick links</h2>
      <div className="actions-row">
        <Link href="/print">
          <button>To print</button>
        </Link>
        <Link href="/queue">
          <button>Open queue ({totalJobs})</button>
        </Link>
        <Link href="/review">
          <button>Resolve needs-review ({needsReview})</button>
        </Link>
        <Link href="/orders">
          <button>Browse orders</button>
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Line items: {li["resolved"] ?? 0} resolved, {li["needs_review"] ?? 0} needs review,{" "}
        {li["pending"] ?? 0} pending.
      </p>
    </>
  );
}
