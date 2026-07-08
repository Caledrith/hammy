import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { filamentMap, orderLineItems, orders, printJobs, type LineItemProperty } from "@/db/schema";
import {
  addOpticAlias,
  reResolveLineItem,
  reResolveProduct,
  setProductFilamentDefault,
  updateJobStatus,
} from "../actions";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  no_bom_rule: "no BOM rule",
  filament_unknown: "filament unknown",
  other: "needs review",
};

export default async function ReviewPage() {
  const db = getDb();

  const rows = await db
    .select({
      jobId: printJobs.id,
      lineItemId: orderLineItems.id,
      optic: printJobs.opticModel,
      reason: printJobs.reviewReason,
      reviewKind: printJobs.reviewKind,
      partType: printJobs.partType,
      quantity: printJobs.quantity,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      orderName: orders.name,
      handle: orderLineItems.productHandle,
      productKey: orderLineItems.productKey,
      sku: orderLineItems.sku,
      title: orderLineItems.title,
      variantTitle: orderLineItems.variantTitle,
      properties: orderLineItems.properties,
    })
    .from(printJobs)
    .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(eq(printJobs.status, "needs_review"))
    .orderBy(asc(printJobs.id))
    .limit(500);

  const filamentRows = await db
    .select({ material: filamentMap.materialOption, color: filamentMap.colorOption })
    .from(filamentMap)
    .orderBy(asc(filamentMap.materialOption), asc(filamentMap.colorOption));
  const materials = [...new Set(filamentRows.map((f) => f.material))];
  const colors = [...new Set(filamentRows.map((f) => f.color))];

  type Row = (typeof rows)[number];
  interface Group {
    key: string;
    productKey: string;
    title: string | null;
    handle: string | null;
    reviewKind: string;
    jobs: Row[];
    orderNames: Set<string>;
    variantCounts: Map<string, number>;
    optics: Set<string>;
    totalUnits: number;
  }

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const productKey = row.productKey ?? row.handle ?? row.sku ?? "unknown";
    const kind = row.reviewKind ?? "other";
    const key = `${productKey}||${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        productKey,
        title: row.title ?? null,
        handle: row.handle ?? null,
        reviewKind: kind,
        jobs: [],
        orderNames: new Set(),
        variantCounts: new Map(),
        optics: new Set(),
        totalUnits: 0,
      };
      groups.set(key, group);
    }
    if (!group.title && row.title) group.title = row.title;
    group.jobs.push(row);
    if (row.orderName) group.orderNames.add(row.orderName);
    const variant = row.variantTitle ?? "(no variant)";
    group.variantCounts.set(variant, (group.variantCounts.get(variant) ?? 0) + 1);
    if (row.optic) group.optics.add(row.optic);
    group.totalUnits += row.quantity ?? 1;
  }

  const groupList = [...groups.values()].sort(
    (a, b) => b.jobs.length - a.jobs.length || a.productKey.localeCompare(b.productKey),
  );

  return (
    <>
      <h1>Needs review</h1>
      <p className="subtitle">
        {rows.length} job(s) across {groupList.length} product group(s) (max 500). Fixes apply to the
        whole product and re-resolve every affected order.
      </p>

      {groupList.length === 0 ? (
        <div className="empty">Nothing to review. Nice.</div>
      ) : (
        groupList.map((group) => {
          const kindLabel = KIND_LABELS[group.reviewKind] ?? "needs review";
          const reasonText =
            group.reviewKind === "no_bom_rule"
              ? "No BOM rule matched these options — set a default filament or add a recipe rule."
              : group.reviewKind === "filament_unknown"
                ? "Material/color not detected — set the product's default filament."
                : (group.jobs[0]?.reason ?? "needs review");
          return (
            <div className="review-card" key={group.key}>
              <div className="head">
                <div>
                  <strong>{group.title ?? group.productKey}</strong>
                  <div className="muted mono">{group.productKey}</div>
                </div>
                <span className="badge needs_review">{kindLabel}</span>
              </div>

              <div className="muted">
                {group.jobs.length} job(s) · {group.totalUnits} unit(s) · {group.orderNames.size}{" "}
                order(s)
              </div>

              <div className="reason">{reasonText}</div>

              <div className="prop-list">
                {[...group.variantCounts.entries()].map(([variant, count]) => (
                  <span className="prop" key={variant}>
                    {variant} ×{count}
                  </span>
                ))}
              </div>

              <div className="actions-row">
                <form action={setProductFilamentDefault} className="inline">
                  <input type="hidden" name="productKey" value={group.productKey} />
                  <input type="hidden" name="productName" value={group.title ?? ""} />
                  <span className="muted">filament</span>
                  <select name="material" defaultValue="" style={{ width: 120 }}>
                    <option value="" disabled>
                      material
                    </option>
                    {materials.map((material) => (
                      <option value={material} key={material}>
                        {material}
                      </option>
                    ))}
                  </select>
                  <select name="color" defaultValue="" style={{ width: 110 }}>
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
                    Set default filament &amp; re-resolve all
                  </button>
                </form>

                <form action={reResolveProduct} className="inline">
                  <input type="hidden" name="productKey" value={group.productKey} />
                  <button type="submit">Re-resolve all</button>
                </form>
              </div>

              {group.optics.size > 0 ? (
                <details className="optic-aliases">
                  <summary>
                    Optic aliases ({group.optics.size}) — optional, only maps the model file, does
                    not clear this review
                  </summary>
                  <div className="actions-row">
                    {[...group.optics].map((optic) => (
                      <form action={addOpticAlias} className="inline" key={optic}>
                        <input type="hidden" name="productKey" value={group.productKey} />
                        <input type="hidden" name="source" value={optic} />
                        <span className="muted">alias &quot;{optic}&quot; &rarr;</span>
                        <input
                          type="text"
                          name="canonical"
                          placeholder="canonical optic model"
                          style={{ width: 220 }}
                        />
                        <button type="submit" className="primary">
                          Add alias &amp; re-resolve all
                        </button>
                      </form>
                    ))}
                  </div>
                </details>
              ) : null}

              <details className="job-list">
                <summary>Show {group.jobs.length} affected job(s)</summary>
                {group.jobs.map((job) => {
                  const props = (job.properties ?? []) as LineItemProperty[];
                  return (
                    <div className="job-row" key={job.jobId}>
                      <div>
                        <strong>{job.orderName ?? "-"}</strong>{" "}
                        <span className="muted mono">#{job.jobId}</span> · {job.title ?? job.partType}
                        {job.variantTitle ? (
                          <span className="muted"> · {job.variantTitle}</span>
                        ) : null}
                      </div>

                      {props.length > 0 ? (
                        <div className="prop-list">
                          {props.map((p, i) => (
                            <span className="prop" key={i}>
                              {p.name}: {p.value}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div className="actions-row">
                        <form action={reResolveLineItem} className="inline">
                          <input type="hidden" name="lineItemId" value={job.lineItemId ?? ""} />
                          <button type="submit">Re-resolve</button>
                        </form>

                        <form action={updateJobStatus} className="inline">
                          <input type="hidden" name="id" value={job.jobId} />
                          <input type="hidden" name="status" value="ready" />
                          <button type="submit">Force ready</button>
                        </form>

                        <form action={updateJobStatus} className="inline">
                          <input type="hidden" name="id" value={job.jobId} />
                          <input type="hidden" name="status" value="cancelled" />
                          <button type="submit" className="danger">
                            Cancel
                          </button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </details>
            </div>
          );
        })
      )}
    </>
  );
}
