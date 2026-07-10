import Link from "next/link";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { orderLineItems, orders, printJobs } from "@/db/schema";
import { brandFromProperties } from "@/lib/recipes/engine";
import {
  markFilamentPrintingJobsDone,
  markFilamentReadyJobsPrinting,
  markOrderPrintingJobsDone,
  markOrderReadyJobsPrinting,
  updateJobStatus,
} from "../actions";

export const dynamic = "force-dynamic";

type Group = "order" | "plate";
type Tab = "to-print" | "printing";
type JobStatus = (typeof printJobs.$inferSelect)["status"];

function fmtDateTime(d: Date | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function fmtMoney(amount: string | null, currency: string | null): string {
  if (amount == null || amount === "") return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

/** Model label with the brand prefixed (e.g. "Leupold MK 4HD 2.5-10x42"). */
function opticLabel(
  optic: string | null,
  properties: { name: string; value: string }[] | null,
): string | null {
  if (!optic) return null;
  // "Universal" parts (e.g. Tip Grip) aren't a specific optic - no brand prefix.
  if (optic === "Universal") return optic;
  const brand = brandFromProperties(properties ?? []);
  return brand ? `${brand} ${optic}` : optic;
}

const PLACEHOLDER_VALUES = new Set(["", "n/a", "na", "none", "not listed", "other", "-"]);

/**
 * Meaningful King Options selections to surface on the card (mag slot count,
 * pegboard type, etc.). Drops placeholder values and hidden app keys, plus the
 * value already shown as the optic so it isn't repeated.
 */
function visibleProps(
  properties: { name: string; value: string }[] | null,
  optic: string | null,
): { name: string; value: string }[] {
  if (!properties) return [];
  return properties.filter((p) => {
    if (!p.name || p.name.startsWith("_")) return false;
    const v = (p.value ?? "").trim();
    if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return false;
    if (optic && v === optic) return false;
    return true;
  });
}

function PropList({ props }: { props: { name: string; value: string }[] }) {
  if (props.length === 0) return null;
  return (
    <div className="prop-list">
      {props.map((p, i) => (
        <span className="prop" key={`${p.name}-${i}`}>
          {p.name}: <strong>{p.value}</strong>
        </span>
      ))}
    </div>
  );
}

function hrefFor(view: Group, tab: Tab): string {
  const params = new URLSearchParams();
  if (view === "plate") params.set("view", "plate");
  if (tab === "printing") params.set("tab", "printing");
  const qs = params.toString();
  return qs ? `/print?${qs}` : "/print";
}

function JobAction({ jobId, status }: { jobId: number; status: JobStatus }) {
  if (status === "ready") {
    return (
      <form action={updateJobStatus} className="inline">
        <input type="hidden" name="id" value={jobId} />
        <input type="hidden" name="status" value="printing" />
        <button type="submit" className="primary">
          Added to printer
        </button>
      </form>
    );
  }
  if (status === "printing") {
    return (
      <span className="actions-row">
        <form action={updateJobStatus} className="inline">
          <input type="hidden" name="id" value={jobId} />
          <input type="hidden" name="status" value="done" />
          <button type="submit" className="primary">
            Printed
          </button>
        </form>
        <form action={updateJobStatus} className="inline">
          <input type="hidden" name="id" value={jobId} />
          <input type="hidden" name="status" value="ready" />
          <button type="submit">Undo</button>
        </form>
      </span>
    );
  }
  return <span className={`badge ${status}`}>{status}</span>;
}

export default async function PrintPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; tab?: string }>;
}) {
  const { view: viewParam, tab: tabParam } = await searchParams;
  const view: Group = viewParam === "plate" ? "plate" : "order";
  const tab: Tab = tabParam === "printing" ? "printing" : "to-print";
  const activeStatus: JobStatus = tab === "printing" ? "printing" : "ready";
  const db = getDb();

  const rows = await db
    .select({
      jobId: printJobs.id,
      status: printJobs.status,
      partType: printJobs.partType,
      optic: printJobs.opticModel,
      quantity: printJobs.quantity,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      colorHex: printJobs.colorHex,
      liTitle: orderLineItems.title,
      variantTitle: orderLineItems.variantTitle,
      properties: orderLineItems.properties,
      unitPrice: orderLineItems.unitPrice,
      orderId: orders.id,
      orderName: orders.name,
      customerName: orders.customerName,
      channel: orders.channel,
      processedAt: orders.processedAt,
      currency: orders.currency,
      orderTotal: orders.totalPrice,
      discountCodes: orders.discountCodes,
    })
    .from(printJobs)
    .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(inArray(printJobs.status, ["ready", "printing"]))
    .orderBy(desc(orders.processedAt), asc(printJobs.id))
    .limit(2000);

  const [nr] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(eq(printJobs.status, "needs_review"));

  type Row = (typeof rows)[number];

  let readyCount = 0;
  let printingCount = 0;
  for (const r of rows) {
    if (r.status === "ready") readyCount += 1;
    else if (r.status === "printing") printingCount += 1;
  }

  const active = rows.filter((r) => r.status === activeStatus);

  // Group by order (newest first, preserving query order).
  interface OrderGroup {
    orderId: number;
    orderName: string | null;
    customerName: string | null;
    channel: string;
    processedAt: Date | null;
    currency: string | null;
    orderTotal: string | null;
    discountCodes: string[];
    jobs: Row[];
  }
  const orderGroups = new Map<number, OrderGroup>();
  for (const row of active) {
    let group = orderGroups.get(row.orderId);
    if (!group) {
      group = {
        orderId: row.orderId,
        orderName: row.orderName,
        customerName: row.customerName,
        channel: row.channel,
        processedAt: row.processedAt,
        currency: row.currency,
        orderTotal: row.orderTotal,
        discountCodes: row.discountCodes ?? [],
        jobs: [],
      };
      orderGroups.set(row.orderId, group);
    }
    group.jobs.push(row);
  }
  const orderList = [...orderGroups.values()];

  // Group by filament (material + color) — a "plate" you'd load onto one printer.
  interface PlateGroup {
    key: string;
    material: string | null;
    color: string | null;
    hex: string | null;
    jobs: Row[];
  }
  const plateMap = new Map<string, PlateGroup>();
  for (const row of active) {
    const key = `${row.material ?? "?"}||${row.color ?? "?"}`;
    let group = plateMap.get(key);
    if (!group) {
      group = { key, material: row.material, color: row.color, hex: row.colorHex, jobs: [] };
      plateMap.set(key, group);
    }
    if (!group.hex && row.colorHex) group.hex = row.colorHex;
    group.jobs.push(row);
  }
  const plateList = [...plateMap.values()].sort((a, b) => b.jobs.length - a.jobs.length);

  const bulkLabel = tab === "printing" ? "All printed" : "All added to printer";
  const orderBulkAction =
    tab === "printing" ? markOrderPrintingJobsDone : markOrderReadyJobsPrinting;
  const plateBulkAction =
    tab === "printing" ? markFilamentPrintingJobsDone : markFilamentReadyJobsPrinting;

  const groupCount = view === "plate" ? plateList.length : orderList.length;
  const groupNoun = view === "plate" ? "plate" : "order";
  const activeCount = tab === "printing" ? printingCount : readyCount;

  const emptyText =
    tab === "printing"
      ? "Nothing on the printer right now."
      : "Nothing waiting to print. Sync orders or check the review queue.";

  return (
    <>
      <h1>To print</h1>
      <p className="subtitle">
        {groupCount} {groupNoun}(s) · {activeCount} job(s) {tab === "printing" ? "on printer" : "waiting"}
      </p>

      <div className="actions-row" style={{ marginBottom: 8 }}>
        <Link href={hrefFor(view, "to-print")}>
          <button className={tab === "to-print" ? "primary" : undefined}>
            To print ({readyCount})
          </button>
        </Link>
        <Link href={hrefFor(view, "printing")}>
          <button className={tab === "printing" ? "primary" : undefined}>
            On printer ({printingCount})
          </button>
        </Link>
      </div>

      <div className="actions-row" style={{ marginBottom: 12 }}>
        <Link href={hrefFor("order", tab)}>
          <button className={view === "order" ? "primary" : undefined}>By order</button>
        </Link>
        <Link href={hrefFor("plate", tab)}>
          <button className={view === "plate" ? "primary" : undefined}>By plate</button>
        </Link>
      </div>

      {nr.count > 0 ? (
        <div className="review-card">
          <div className="reason">
            {nr.count} job(s) need review before they can print.{" "}
            <Link href="/review">Open review queue</Link>
          </div>
        </div>
      ) : null}

      {view === "plate" ? (
        plateList.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          plateList.map((group) => (
            <div className="review-card" key={group.key}>
              <div className="head">
                <div>
                  <strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span
                      className="swatch"
                      style={{ background: group.hex ?? "transparent", width: 16, height: 16 }}
                    />
                    {group.material ?? "?"} / {group.color ?? "?"}
                  </strong>
                  <div className="muted mono">{group.jobs.length} job(s)</div>
                </div>
                <form action={plateBulkAction} className="inline">
                  <input type="hidden" name="material" value={group.material ?? ""} />
                  <input type="hidden" name="color" value={group.color ?? ""} />
                  <button type="submit" className="primary">
                    {bulkLabel}
                  </button>
                </form>
              </div>

              {group.jobs.map((job) => {
                const optic = opticLabel(job.optic, job.properties);
                const props = visibleProps(job.properties, job.optic);
                return (
                  <div className="job-row" key={job.jobId}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <strong>{job.partType}</strong>
                      {optic ? (
                        <>
                          {" · "}
                          <strong>{optic}</strong>
                        </>
                      ) : null}
                      <div className="muted">
                        {job.orderName ?? `#${job.orderId}`} · {job.liTitle ?? "-"}
                        {job.variantTitle ? ` · ${job.variantTitle}` : ""}
                        {job.unitPrice ? ` · ${fmtMoney(job.unitPrice, job.currency)}` : ""}
                      </div>
                      <PropList props={props} />
                    </div>
                    <div className="mono">&times;{job.quantity}</div>
                    <div>
                      <JobAction jobId={job.jobId} status={job.status} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )
      ) : orderList.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        orderList.map((group) => (
          <div className="review-card" key={group.orderId}>
            <div className="head">
              <div>
                <strong>{group.orderName ?? `#${group.orderId}`}</strong>{" "}
                <span className="badge pending" style={{ marginRight: 6 }}>
                  {group.channel}
                </span>
                <span className="muted">{group.customerName ?? ""}</span>
                {group.orderTotal ? (
                  <strong style={{ marginLeft: 6 }}>
                    {fmtMoney(group.orderTotal, group.currency)}
                  </strong>
                ) : null}
                <div className="muted mono">{fmtDateTime(group.processedAt)}</div>
                {group.discountCodes.length > 0 ? (
                  <div style={{ marginTop: 2 }}>
                    {group.discountCodes.map((code) => (
                      <span
                        key={code}
                        className="badge cancelled"
                        style={{ marginRight: 4 }}
                        title="Discount code applied to this order"
                      >
                        code: {code}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <form action={orderBulkAction} className="inline">
                <input type="hidden" name="orderId" value={group.orderId} />
                <button type="submit" className="primary">
                  {bulkLabel}
                </button>
              </form>
            </div>

            {group.jobs.map((job) => {
              const optic = opticLabel(job.optic, job.properties);
              const props = visibleProps(job.properties, job.optic);
              return (
              <div className="job-row" key={job.jobId}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <strong>{job.partType}</strong>
                  {optic ? (
                    <>
                      {" · "}
                      <strong>{optic}</strong>
                    </>
                  ) : null}
                  <div className="muted">
                    {job.liTitle ?? "-"}
                    {job.variantTitle ? ` · ${job.variantTitle}` : ""}
                    {job.unitPrice ? ` · ${fmtMoney(job.unitPrice, job.currency)}` : ""}
                  </div>
                  <PropList props={props} />
                </div>

                <div style={{ minWidth: 140 }}>
                  {job.material || job.color ? (
                    <span>
                      {job.colorHex ? (
                        <span
                          className="swatch"
                          style={{
                            background: job.colorHex,
                            width: 10,
                            height: 10,
                            marginRight: 6,
                          }}
                        />
                      ) : null}
                      {job.material ?? "?"} / {job.color ?? "?"}
                    </span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </div>

                <div className="mono">&times;{job.quantity}</div>

                <div>
                  <JobAction jobId={job.jobId} status={job.status} />
                </div>
              </div>
              );
            })}
          </div>
        ))
      )}
    </>
  );
}
