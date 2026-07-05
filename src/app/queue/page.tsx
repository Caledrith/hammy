import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { orderLineItems, orders, printJobs } from "@/db/schema";
import { setJobPriority, updateJobStatus } from "../actions";

export const dynamic = "force-dynamic";

type JobStatus = (typeof printJobs.$inferSelect)["status"];

const FILTERS = [
  "all",
  "ready",
  "needs_review",
  "pending",
  "assigned",
  "printing",
  "done",
  "failed",
  "cancelled",
] as const;

const STATUS_OPTIONS: JobStatus[] = [
  "pending",
  "ready",
  "needs_review",
  "assigned",
  "printing",
  "done",
  "failed",
  "cancelled",
];

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const active = (status ?? "all") as (typeof FILTERS)[number];
  const db = getDb();

  const base = db
    .select({
      id: printJobs.id,
      status: printJobs.status,
      partType: printJobs.partType,
      optic: printJobs.opticModel,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      colorHex: printJobs.colorHex,
      profile: printJobs.slicerProfile,
      quantity: printJobs.quantity,
      priority: printJobs.priority,
      reason: printJobs.reviewReason,
      orderName: orders.name,
      handle: orderLineItems.productHandle,
    })
    .from(printJobs)
    .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id));

  const rows = await (active === "all"
    ? base
    : base.where(eq(printJobs.status, active as JobStatus))
  )
    .orderBy(desc(printJobs.priority), asc(printJobs.id))
    .limit(300);

  return (
    <>
      <h1>Print queue</h1>
      <p className="subtitle">{rows.length} jobs shown (max 300).</p>

      <div className="filters">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/queue" : `/queue?status=${f}`}
            className={active === f ? "active" : ""}
          >
            {f}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="empty">No jobs for this filter.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Order</th>
              <th>Part</th>
              <th>Optic</th>
              <th>Filament</th>
              <th>Qty</th>
              <th>Priority</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <td className="mono">{j.id}</td>
                <td>
                  <div>{j.orderName ?? "-"}</div>
                  <div className="muted mono">{j.handle ?? ""}</div>
                </td>
                <td>
                  {j.partType}
                  {j.reason ? <div className="reason">{j.reason}</div> : null}
                </td>
                <td>{j.optic ?? <span className="muted">-</span>}</td>
                <td>
                  {j.material || j.color ? (
                    <span>
                      {j.colorHex ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: j.colorHex,
                            marginRight: 6,
                            border: "1px solid var(--border)",
                          }}
                        />
                      ) : null}
                      {j.material ?? "?"} / {j.color ?? "?"}
                      <div className="muted mono">{j.profile ?? ""}</div>
                    </span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td className="mono">{j.quantity}</td>
                <td>
                  <form action={setJobPriority} className="inline">
                    <input type="hidden" name="id" value={j.id} />
                    <input
                      type="number"
                      name="priority"
                      defaultValue={j.priority}
                      style={{ width: 56 }}
                    />
                    <button type="submit">Set</button>
                  </form>
                </td>
                <td>
                  <span className={`badge ${j.status}`}>{j.status}</span>
                  <form action={updateJobStatus} className="inline" style={{ marginTop: 6 }}>
                    <input type="hidden" name="id" value={j.id} />
                    <select name="status" defaultValue={j.status}>
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Set</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
