import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { filamentMap, orderLineItems, orders, printJobs, type LineItemProperty } from "@/db/schema";
import {
  addOpticAlias,
  reResolveLineItem,
  setLineItemFilamentDefault,
  updateJobStatus,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const db = getDb();

  const rows = await db
    .select({
      jobId: printJobs.id,
      lineItemId: orderLineItems.id,
      optic: printJobs.opticModel,
      reason: printJobs.reviewReason,
      partType: printJobs.partType,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      orderName: orders.name,
      handle: orderLineItems.productHandle,
      title: orderLineItems.title,
      variantTitle: orderLineItems.variantTitle,
      properties: orderLineItems.properties,
    })
    .from(printJobs)
    .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(eq(printJobs.status, "needs_review"))
    .orderBy(asc(printJobs.id))
    .limit(100);
  const filamentRows = await db
    .select({ material: filamentMap.materialOption, color: filamentMap.colorOption })
    .from(filamentMap)
    .orderBy(asc(filamentMap.materialOption), asc(filamentMap.colorOption));
  const materials = [...new Set(filamentRows.map((f) => f.material))];
  const colors = [...new Set(filamentRows.map((f) => f.color))];

  return (
    <>
      <h1>Needs review</h1>
      <p className="subtitle">
        {rows.length} job(s) need attention (max 100). Add a model file / recipe, or map an optic
        alias and re-resolve.
      </p>

      {rows.length === 0 ? (
        <div className="empty">Nothing to review. Nice.</div>
      ) : (
        rows.map((j) => {
          const props = (j.properties ?? []) as LineItemProperty[];
          return (
            <div className="review-card" key={j.jobId}>
              <div className="head">
                <div>
                  <strong>{j.orderName ?? "-"}</strong> &middot; {j.title ?? j.partType}{" "}
                  <span className="muted mono">#{j.jobId}</span>
                  <div className="muted mono">{j.handle ?? ""}</div>
                </div>
                <span className="badge needs_review">{j.partType}</span>
              </div>

              <div className="reason">{j.reason ?? "needs review"}</div>

              <div className="prop-list">
                {j.variantTitle ? <span className="prop">variant: {j.variantTitle}</span> : null}
                {j.material ? <span className="prop">material: {j.material}</span> : null}
                {j.color ? <span className="prop">color: {j.color}</span> : null}
                {props.map((p, i) => (
                  <span className="prop" key={i}>
                    {p.name}: {p.value}
                  </span>
                ))}
              </div>

              <div className="actions-row">
                <form action={setLineItemFilamentDefault} className="inline">
                  <input type="hidden" name="lineItemId" value={j.lineItemId ?? ""} />
                  <span className="muted">filament</span>
                  <select name="material" defaultValue={j.material ?? ""} style={{ width: 120 }}>
                    <option value="" disabled>
                      material
                    </option>
                    {materials.map((material) => (
                      <option value={material} key={material}>
                        {material}
                      </option>
                    ))}
                  </select>
                  <select name="color" defaultValue={j.color ?? ""} style={{ width: 110 }}>
                    <option value="" disabled>
                      color
                    </option>
                    {colors.map((color) => (
                      <option value={color} key={color}>
                        {color}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="primary">
                    Set filament &amp; re-resolve
                  </button>
                </form>

                {j.optic ? (
                  <form action={addOpticAlias} className="inline">
                    <input type="hidden" name="lineItemId" value={j.lineItemId ?? ""} />
                    <input type="hidden" name="source" value={j.optic} />
                    <span className="muted">alias &quot;{j.optic}&quot; &rarr;</span>
                    <input
                      type="text"
                      name="canonical"
                      placeholder="canonical optic model"
                      style={{ width: 220 }}
                    />
                    <button type="submit" className="primary">
                      Add alias &amp; re-resolve
                    </button>
                  </form>
                ) : null}

                <form action={reResolveLineItem} className="inline">
                  <input type="hidden" name="lineItemId" value={j.lineItemId ?? ""} />
                  <button type="submit">Re-resolve</button>
                </form>

                <form action={updateJobStatus} className="inline">
                  <input type="hidden" name="id" value={j.jobId} />
                  <input type="hidden" name="status" value="ready" />
                  <button type="submit">Force ready</button>
                </form>

                <form action={updateJobStatus} className="inline">
                  <input type="hidden" name="id" value={j.jobId} />
                  <input type="hidden" name="status" value="cancelled" />
                  <button type="submit" className="danger">
                    Cancel
                  </button>
                </form>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
