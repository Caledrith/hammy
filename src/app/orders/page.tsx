import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { orderLineItems, orders, printJobs } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const db = getDb();

  const orderRows = await db
    .select()
    .from(orders)
    .orderBy(desc(orders.processedAt))
    .limit(50);

  const orderIds = orderRows.map((o) => o.id);
  const lineItems = orderIds.length
    ? await db.select().from(orderLineItems).where(inArray(orderLineItems.orderId, orderIds))
    : [];
  const liIds = lineItems.map((l) => l.id);
  const jobs = liIds.length
    ? await db.select().from(printJobs).where(inArray(printJobs.orderLineItemId, liIds))
    : [];

  const jobsByLi = new Map<number, typeof jobs>();
  for (const j of jobs) {
    const list = jobsByLi.get(j.orderLineItemId) ?? [];
    list.push(j);
    jobsByLi.set(j.orderLineItemId, list);
  }
  const liByOrder = new Map<number, typeof lineItems>();
  for (const l of lineItems) {
    const list = liByOrder.get(l.orderId) ?? [];
    list.push(l);
    liByOrder.set(l.orderId, list);
  }

  return (
    <>
      <h1>Orders</h1>
      <p className="subtitle">{orderRows.length} most recent synced orders.</p>

      {orderRows.length === 0 ? (
        <div className="empty">No orders synced yet.</div>
      ) : (
        orderRows.map((o) => (
          <div className="review-card" key={o.id}>
            <div className="head">
              <div>
                <strong>{o.name ?? o.externalId}</strong>{" "}
                <span className="badge pending" style={{ marginRight: 6 }}>
                  {o.channel}
                </span>
                <span className="muted">{o.customerName ?? ""}</span>
                <div className="muted mono">
                  {o.processedAt ? new Date(o.processedAt).toISOString().slice(0, 10) : "-"}
                </div>
              </div>
              <div>
                <span className={`badge ${o.cancelledAt ? "cancelled" : "ready"}`}>
                  {o.financialStatus ?? "?"}
                </span>{" "}
                <span className="muted">{o.fulfillmentStatus ?? ""}</span>
              </div>
            </div>

            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Line item</th>
                  <th>Variant</th>
                  <th>Qty</th>
                  <th>Print jobs</th>
                </tr>
              </thead>
              <tbody>
                {(liByOrder.get(o.id) ?? []).map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.title}
                      <div className="muted mono">{l.productHandle ?? ""}</div>
                    </td>
                    <td className="muted">{l.variantTitle ?? "-"}</td>
                    <td className="mono">{l.quantity}</td>
                    <td>
                      {(jobsByLi.get(l.id) ?? []).length === 0 ? (
                        <span className="muted">-</span>
                      ) : (
                        (jobsByLi.get(l.id) ?? []).map((j) => (
                          <span
                            key={j.id}
                            className={`badge ${j.status}`}
                            style={{ marginRight: 4, marginBottom: 4 }}
                            title={j.reviewReason ?? ""}
                          >
                            {j.partType}
                            {j.opticModel ? ` · ${j.opticModel}` : ""}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
