import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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

// Orders rendered per page in the "By order" view. Keeps the HTML small so the
// page renders fast even with a large printing backlog.
const ORDERS_PER_PAGE = 25;

// Jobs rendered per page when drilling into a single plate (By plate → items).
const JOBS_PER_PAGE = 100;

/** Encode/decode a plate key (material + color) for the ?plate= param. */
function plateKey(material: string | null, color: string | null): string {
  return `${material ?? ""}|||${color ?? ""}`;
}
function parsePlateKey(key: string): { material: string; color: string } | null {
  const idx = key.indexOf("|||");
  if (idx < 0) return null;
  const material = key.slice(0, idx);
  const color = key.slice(idx + 3);
  if (!material || !color) return null;
  return { material, color };
}

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

/**
 * Product name for display: drops the SEO/category suffix after " | "
 * (e.g. "| Magazine Holder Storage Rack") while keeping the mount type
 * ("- Wall", "- Pegboard / ...") that distinguishes the physical print.
 */
function shortTitle(title: string | null): string | null {
  if (!title) return null;
  const cut = title.split(" | ")[0]?.trim();
  return cut || title.trim();
}

/** part types that carry no product info on their own (single-part fallback). */
const GENERIC_PARTS = new Set(["print", "(no BOM rule)"]);

/**
 * The prominent job label. Named parts (e.g. "objective_cover") describe
 * themselves; the generic "print" part is replaced with the product name so the
 * operator sees what the item is instead of a meaningless "print".
 */
function jobName(partType: string, title: string | null): { name: string; showTitle: boolean } {
  if (GENERIC_PARTS.has(partType)) {
    const short = shortTitle(title);
    if (short) return { name: short, showTitle: false };
  }
  return { name: partType, showTitle: true };
}

/** Join the secondary muted line, dropping empty pieces. */
function secondary(pieces: (string | false | null | undefined)[]): string {
  return pieces.filter((p): p is string => Boolean(p)).join(" · ");
}

/** Link to a view/tab (always resets to the first page). */
function hrefFor(view: Group, tab: Tab): string {
  const params = new URLSearchParams();
  if (view === "plate") params.set("view", "plate");
  if (tab === "printing") params.set("tab", "printing");
  const qs = params.toString();
  return qs ? `/print?${qs}` : "/print";
}

/** Link to a specific page within the current view/tab (and plate, if drilled in). */
function pageHref(view: Group, tab: Tab, page: number, plate?: string | null): string {
  const params = new URLSearchParams();
  if (view === "plate") params.set("view", "plate");
  if (tab === "printing") params.set("tab", "printing");
  if (plate) params.set("plate", plate);
  if (page > 0) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/print?${qs}` : "/print";
}

function Pager({
  view,
  tab,
  page,
  totalPages,
  plate,
}: {
  view: Group;
  tab: Tab;
  page: number;
  totalPages: number;
  plate?: string | null;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="actions-row" style={{ marginTop: 12, alignItems: "center" }}>
      {page > 0 ? (
        <Link href={pageHref(view, tab, page - 1, plate)}>
          <button>‹ Prev</button>
        </Link>
      ) : (
        <button disabled>‹ Prev</button>
      )}
      <span className="muted">
        Page {page + 1} of {totalPages}
      </span>
      {page < totalPages - 1 ? (
        <Link href={pageHref(view, tab, page + 1, plate)}>
          <button>Next ›</button>
        </Link>
      ) : (
        <button disabled>Next ›</button>
      )}
    </div>
  );
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

interface JobRowData {
  jobId: number;
  status: JobStatus;
  partType: string;
  optic: string | null;
  quantity: number;
  material: string | null;
  color: string | null;
  colorHex: string | null;
  liTitle: string | null;
  variantTitle: string | null;
  properties: { name: string; value: string }[] | null;
  unitPrice: string | null;
  currency: string | null;
  orderId: number;
  // Present in the plate drill-in (jobs aren't grouped by order there).
  orderName?: string | null;
  processedAt?: Date | null;
}

function JobRow({ job }: { job: JobRowData }) {
  const optic = opticLabel(job.optic, job.properties);
  const props = visibleProps(job.properties, job.optic);
  const { name, showTitle } = jobName(job.partType, job.liTitle);
  const showOrder = job.orderName !== undefined;
  return (
    <div className="job-row">
      <div style={{ flex: 1, minWidth: 200 }}>
        {showOrder ? (
          <div className="muted mono" style={{ marginBottom: 2 }}>
            {job.orderName ?? `#${job.orderId}`} · {fmtDateTime(job.processedAt ?? null)}
          </div>
        ) : null}
        <strong>{name}</strong>
        {optic ? (
          <>
            {" · "}
            <strong>{optic}</strong>
          </>
        ) : null}
        <div className="muted">
          {secondary([
            showTitle && (job.liTitle ?? "-"),
            job.variantTitle,
            job.unitPrice && fmtMoney(job.unitPrice, job.currency),
          ])}
        </div>
        <PropList props={props} />
      </div>

      <div style={{ minWidth: 140 }}>
        {job.material || job.color ? (
          <span>
            {job.colorHex ? (
              <span
                className="swatch"
                style={{ background: job.colorHex, width: 10, height: 10, marginRight: 6 }}
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
}

export default async function PrintPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; tab?: string; page?: string; plate?: string }>;
}) {
  const {
    view: viewParam,
    tab: tabParam,
    page: pageParam,
    plate: plateParam,
  } = await searchParams;
  const view: Group = viewParam === "plate" ? "plate" : "order";
  const tab: Tab = tabParam === "printing" ? "printing" : "to-print";
  const activeStatus: JobStatus = tab === "printing" ? "printing" : "ready";
  const page = Math.max(0, Number.parseInt(pageParam ?? "0", 10) || 0);
  const selectedPlate = view === "plate" && plateParam ? parsePlateKey(plateParam) : null;
  const db = getDb();

  // Cheap counts for the tab badges + review banner (no row loading).
  const [[ready], [printing], [nr]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(printJobs).where(eq(printJobs.status, "ready")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(printJobs)
      .where(eq(printJobs.status, "printing")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(printJobs)
      .where(eq(printJobs.status, "needs_review")),
  ]);
  const readyCount = ready?.n ?? 0;
  const printingCount = printing?.n ?? 0;
  const activeCount = tab === "printing" ? printingCount : readyCount;

  const bulkLabel = tab === "printing" ? "All printed" : "All added to printer";
  const orderBulkAction =
    tab === "printing" ? markOrderPrintingJobsDone : markOrderReadyJobsPrinting;
  const plateBulkAction =
    tab === "printing" ? markFilamentPrintingJobsDone : markFilamentReadyJobsPrinting;

  const emptyText =
    tab === "printing"
      ? "Nothing on the printer right now."
      : "Nothing waiting to print. Sync orders or check the review queue.";

  // ---- Plate view: summary cards per filament; drilling into one shows its
  // jobs (with order details) paginated.
  let plateRows: { material: string | null; color: string | null; hex: string | null; n: number }[] =
    [];
  let plateJobs: JobRowData[] = [];
  let plateTotal = 0;
  if (view === "plate" && selectedPlate) {
    const [cnt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(printJobs)
      .where(
        and(
          eq(printJobs.status, activeStatus),
          eq(printJobs.materialOption, selectedPlate.material),
          eq(printJobs.colorOption, selectedPlate.color),
        ),
      );
    plateTotal = cnt?.n ?? 0;

    plateJobs = await db
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
        currency: orders.currency,
        orderId: orders.id,
        orderName: orders.name,
        processedAt: orders.processedAt,
      })
      .from(printJobs)
      .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
      .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
      .where(
        and(
          eq(printJobs.status, activeStatus),
          eq(printJobs.materialOption, selectedPlate.material),
          eq(printJobs.colorOption, selectedPlate.color),
        ),
      )
      .orderBy(desc(orders.processedAt), asc(printJobs.id))
      .limit(JOBS_PER_PAGE)
      .offset(page * JOBS_PER_PAGE);
  } else if (view === "plate") {
    plateRows = await db
      .select({
        material: printJobs.materialOption,
        color: printJobs.colorOption,
        hex: sql<string | null>`max(${printJobs.colorHex})`,
        n: sql<number>`count(*)::int`,
      })
      .from(printJobs)
      .where(eq(printJobs.status, activeStatus))
      .groupBy(printJobs.materialOption, printJobs.colorOption)
      .orderBy(sql`count(*) desc`);
  }

  // ---- Order view: paginate by order, then load only that page's jobs.
  interface OrderHeader {
    orderId: number;
    orderName: string | null;
    customerName: string | null;
    channel: string;
    processedAt: Date | null;
    currency: string | null;
    orderTotal: string | null;
    discountCodes: string[];
  }
  let totalOrders = 0;
  let orderHeaders: OrderHeader[] = [];
  const jobsByOrder = new Map<number, JobRowData[]>();
  if (view === "order") {
    const [cnt] = await db
      .select({ n: sql<number>`count(distinct ${orders.id})::int` })
      .from(printJobs)
      .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
      .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
      .where(eq(printJobs.status, activeStatus));
    totalOrders = cnt?.n ?? 0;

    orderHeaders = await db
      .select({
        orderId: orders.id,
        orderName: orders.name,
        customerName: orders.customerName,
        channel: orders.channel,
        processedAt: orders.processedAt,
        currency: orders.currency,
        orderTotal: orders.totalPrice,
        discountCodes: orders.discountCodes,
      })
      .from(orders)
      .innerJoin(orderLineItems, eq(orderLineItems.orderId, orders.id))
      .innerJoin(printJobs, eq(printJobs.orderLineItemId, orderLineItems.id))
      .where(eq(printJobs.status, activeStatus))
      .groupBy(orders.id)
      .orderBy(desc(orders.processedAt))
      .limit(ORDERS_PER_PAGE)
      .offset(page * ORDERS_PER_PAGE);

    const pageOrderIds = orderHeaders.map((o) => o.orderId);
    if (pageOrderIds.length > 0) {
      const jobRows = await db
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
          currency: orders.currency,
          orderId: orders.id,
        })
        .from(printJobs)
        .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
        .innerJoin(orders, eq(orderLineItems.orderId, orders.id))
        .where(and(inArray(orders.id, pageOrderIds), eq(printJobs.status, activeStatus)))
        .orderBy(asc(printJobs.id));
      for (const j of jobRows) {
        const list = jobsByOrder.get(j.orderId) ?? [];
        list.push(j);
        jobsByOrder.set(j.orderId, list);
      }
    }
  }

  const totalPages =
    view === "plate" && selectedPlate
      ? Math.max(1, Math.ceil(plateTotal / JOBS_PER_PAGE))
      : Math.max(1, Math.ceil(totalOrders / ORDERS_PER_PAGE));

  let subtitle: string;
  if (view === "plate" && selectedPlate) {
    subtitle = `${plateTotal} job(s) ${tab === "printing" ? "on printer" : "waiting"}`;
  } else if (view === "plate") {
    subtitle = `${plateRows.length} plate(s) · ${activeCount} job(s) ${tab === "printing" ? "on printer" : "waiting"}`;
  } else {
    subtitle = `${totalOrders} order(s) · ${activeCount} job(s) ${tab === "printing" ? "on printer" : "waiting"}`;
  }

  return (
    <>
      <h1>To print</h1>
      <p className="subtitle">{subtitle}</p>

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

      {nr?.n > 0 ? (
        <div className="review-card">
          <div className="reason">
            {nr.n} job(s) need review before they can print.{" "}
            <Link href="/review">Open review queue</Link>
          </div>
        </div>
      ) : null}

      {view === "plate" && selectedPlate ? (
        <>
          <div className="actions-row" style={{ marginBottom: 8 }}>
            <Link href={hrefFor("plate", tab)}>
              <button>‹ All plates</button>
            </Link>
          </div>
          <div className="review-card">
            <div className="head">
              <div>
                <strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="swatch"
                    style={{
                      background: plateJobs[0]?.colorHex ?? "transparent",
                      width: 16,
                      height: 16,
                    }}
                  />
                  {selectedPlate.material} / {selectedPlate.color}
                </strong>
                <div className="muted mono">{plateTotal} job(s)</div>
              </div>
              <form action={plateBulkAction} className="inline">
                <input type="hidden" name="material" value={selectedPlate.material} />
                <input type="hidden" name="color" value={selectedPlate.color} />
                <button type="submit" className="primary">
                  {bulkLabel}
                </button>
              </form>
            </div>
            {plateJobs.length === 0 ? (
              <div className="empty">{emptyText}</div>
            ) : (
              plateJobs.map((job) => <JobRow key={job.jobId} job={job} />)
            )}
          </div>
          <Pager view={view} tab={tab} page={page} totalPages={totalPages} plate={plateParam} />
        </>
      ) : view === "plate" ? (
        plateRows.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <>
            <p className="subtitle">
              Grouped by filament — pick a plate to batch onto a printer and see its items.
            </p>
            {plateRows.map((g) => (
              <div className="review-card" key={`${g.material ?? "?"}||${g.color ?? "?"}`}>
                <div className="head">
                  <div>
                    <strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span
                        className="swatch"
                        style={{ background: g.hex ?? "transparent", width: 16, height: 16 }}
                      />
                      {g.material ?? "?"} / {g.color ?? "?"}
                    </strong>
                    <div className="muted mono">{g.n} job(s)</div>
                  </div>
                  {g.material && g.color ? (
                    <div className="actions-row">
                      <Link href={pageHref("plate", tab, 0, plateKey(g.material, g.color))}>
                        <button>View items</button>
                      </Link>
                      <form action={plateBulkAction} className="inline">
                        <input type="hidden" name="material" value={g.material} />
                        <input type="hidden" name="color" value={g.color} />
                        <button type="submit" className="primary">
                          {bulkLabel}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="muted">needs review</span>
                  )}
                </div>
              </div>
            ))}
          </>
        )
      ) : orderHeaders.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <>
          {orderHeaders.map((group) => (
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

              {(jobsByOrder.get(group.orderId) ?? []).map((job) => (
                <JobRow key={job.jobId} job={job} />
              ))}
            </div>
          ))}
          <Pager view={view} tab={tab} page={page} totalPages={totalPages} />
        </>
      )}
    </>
  );
}
