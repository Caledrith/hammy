import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  filamentMap,
  orderLineItems,
  plateJobs,
  plates,
  printableFiles,
  printJobs,
} from "@/db/schema";
import {
  DEFAULT_PLATE,
  filamentKey,
  plateGroupKey,
  resolveNozzle,
  resolvePlateType,
  type FilamentSpec,
} from "@/lib/plates/grouping";
import { composePlatesForGroup } from "../actions";

export const dynamic = "force-dynamic";

// A "plate" is what can physically share one printer setup: the same filament
// (material + color) AND the same nozzle + plate type. PLA Black and PLA White
// can't share, and neither can a 0.4mm smooth-plate job and a 0.6mm textured one.
const PLATE_STATUSES = ["ready", "assigned"] as const;

interface PlateItem {
  label: string;
  partType: string;
  units: number;
  missingModel: boolean;
}

interface Plate {
  key: string;
  material: string;
  color: string;
  hex: string | null;
  nozzle: number;
  plateType: string;
  hardened: boolean;
  needsEnclosure: boolean;
  totalUnits: number;
  readyUnits: number;
  jobCount: number;
  missingModelUnits: number;
  estGrams: number;
  estMinutes: number;
  hasEstimates: boolean;
  items: Map<string, PlateItem>;
}

type PlateStatus = (typeof plates.$inferSelect)["status"];

function fmtDuration(minutes: number): string {
  if (minutes <= 0) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default async function PlatesPage() {
  const db = getDb();

  const [rows, filaments, composedRows, unitRows, itemRows] = await Promise.all([
    db
      .select({
        id: printJobs.id,
        status: printJobs.status,
        partType: printJobs.partType,
        material: printJobs.materialOption,
        color: printJobs.colorOption,
        colorHex: printJobs.colorHex,
        quantity: printJobs.quantity,
        printableFileId: printJobs.printableFileId,
        estGrams: printableFiles.estGrams,
        estMinutes: printableFiles.estMinutes,
        nozzle: printableFiles.nozzleDiameter,
        filePlateType: printableFiles.plateType,
        title: orderLineItems.title,
        handle: orderLineItems.productHandle,
      })
      .from(printJobs)
      .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
      .leftJoin(printableFiles, eq(printJobs.printableFileId, printableFiles.id))
      .where(inArray(printJobs.status, [...PLATE_STATUSES])),
    db
      .select({
        material: filamentMap.materialOption,
        color: filamentMap.colorOption,
        hex: filamentMap.colorHex,
        defaultPlateType: filamentMap.defaultPlateType,
        hardened: filamentMap.hardenedNozzle,
        needsEnclosure: filamentMap.needsEnclosure,
      })
      .from(filamentMap),
    db.select().from(plates).orderBy(desc(plates.createdAt)).limit(100),
    db
      .select({
        plateId: plateJobs.plateId,
        units: sql<number>`sum(${plateJobs.quantity})::int`,
        jobs: sql<number>`count(*)::int`,
      })
      .from(plateJobs)
      .groupBy(plateJobs.plateId),
    db
      .select({
        plateId: plateJobs.plateId,
        units: plateJobs.quantity,
        partType: printJobs.partType,
        title: orderLineItems.title,
        handle: orderLineItems.productHandle,
      })
      .from(plateJobs)
      .innerJoin(printJobs, eq(plateJobs.printJobId, printJobs.id))
      .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id)),
  ]);

  // Filament-driven specs (swatch, plate default, nozzle/enclosure needs) keyed
  // by material||color for jobs whose file didn't pin them at resolve time.
  const specByFilament = new Map<string, FilamentSpec>();
  for (const f of filaments) {
    specByFilament.set(filamentKey(f.material ?? "", f.color ?? ""), {
      hex: f.hex,
      defaultPlateType: f.defaultPlateType,
      hardened: f.hardened,
      needsEnclosure: f.needsEnclosure,
    });
  }

  const platesMap = new Map<string, Plate>();
  for (const r of rows) {
    const material = r.material ?? "Unknown";
    const color = r.color ?? "Unknown";
    const filKey = filamentKey(material, color);
    const spec = specByFilament.get(filKey);

    const nozzle = resolveNozzle(r.nozzle);
    const plateType = resolvePlateType(r.filePlateType, spec);
    const key = plateGroupKey(material, color, nozzle, plateType);

    let plate = platesMap.get(key);
    if (!plate) {
      plate = {
        key,
        material,
        color,
        hex: r.colorHex ?? spec?.hex ?? null,
        nozzle,
        plateType,
        hardened: spec?.hardened ?? false,
        needsEnclosure: spec?.needsEnclosure ?? false,
        totalUnits: 0,
        readyUnits: 0,
        jobCount: 0,
        missingModelUnits: 0,
        estGrams: 0,
        estMinutes: 0,
        hasEstimates: false,
        items: new Map(),
      };
      platesMap.set(key, plate);
    }
    if (!plate.hex && r.colorHex) plate.hex = r.colorHex;

    const units = r.quantity;
    const missingModel = r.printableFileId == null;
    plate.totalUnits += units;
    if (r.status === "ready" && !missingModel) plate.readyUnits += units;
    plate.jobCount += 1;
    if (missingModel) plate.missingModelUnits += units;
    if (r.estGrams != null) {
      plate.estGrams += r.estGrams * units;
      plate.hasEstimates = true;
    }
    if (r.estMinutes != null) {
      plate.estMinutes += r.estMinutes * units;
      plate.hasEstimates = true;
    }

    const label = r.title ?? r.handle ?? r.partType;
    const itemKey = `${label}||${r.partType}`;
    const item = plate.items.get(itemKey);
    if (item) {
      item.units += units;
      item.missingModel = item.missingModel || missingModel;
    } else {
      plate.items.set(itemKey, { label, partType: r.partType, units, missingModel });
    }
  }

  const plateList = [...platesMap.values()].sort((a, b) => b.totalUnits - a.totalUnits);
  const totalUnits = plateList.reduce((a, p) => a + p.totalUnits, 0);
  const missingModelUnits = plateList.reduce((a, p) => a + p.missingModelUnits, 0);
  const readyToCompose = plateList.reduce((a, p) => a + p.readyUnits, 0);

  // Composed-plate rollups.
  const unitByPlate = new Map(unitRows.map((u) => [u.plateId, u]));
  const itemsByPlate = new Map<number, Map<string, PlateItem>>();
  for (const it of itemRows) {
    let m = itemsByPlate.get(it.plateId);
    if (!m) {
      m = new Map();
      itemsByPlate.set(it.plateId, m);
    }
    const label = it.title ?? it.handle ?? it.partType;
    const itemKey = `${label}||${it.partType}`;
    const existing = m.get(itemKey);
    if (existing) existing.units += it.units;
    else m.set(itemKey, { label, partType: it.partType, units: it.units, missingModel: false });
  }

  const activeComposed = composedRows.filter(
    (p) => p.status !== "done" && p.status !== "cancelled",
  );

  return (
    <>
      <h1>Plates by filament</h1>
      <p className="subtitle">
        Ready &amp; assigned jobs grouped by what can share one printer setup: filament (material +
        color) plus nozzle and plate type. Compose a group into plates for the slicer worker.
      </p>

      <div className="cards">
        <div className="card">
          <div className="num">{plateList.length}</div>
          <div className="label">Plate groups</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: "var(--green)" }}>
            {readyToCompose}
          </div>
          <div className="label">Units ready to compose</div>
        </div>
        <div className="card">
          <div className="num">{totalUnits}</div>
          <div className="label">Units ready + assigned</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: missingModelUnits ? "var(--amber)" : undefined }}>
            {missingModelUnits}
          </div>
          <div className="label">Units without model file</div>
        </div>
      </div>

      {activeComposed.length > 0 ? (
        <>
          <h2>Composed plates</h2>
          <div className="plate-grid">
            {activeComposed.map((p) => {
              const roll = unitByPlate.get(p.id);
              const items = [...(itemsByPlate.get(p.id)?.values() ?? [])].sort(
                (a, b) => b.units - a.units,
              );
              return (
                <div className="plate" key={p.id}>
                  <div className="plate-head">
                    <span
                      className="plate-swatch"
                      style={{ background: p.colorHex ?? "transparent" }}
                      aria-hidden
                    />
                    <div>
                      <div className="plate-title">
                        {p.materialOption ?? "?"} · {p.colorOption ?? "?"}
                      </div>
                      <div className="plate-sub">
                        Plate #{p.id} · {roll?.jobs ?? 0} job{(roll?.jobs ?? 0) === 1 ? "" : "s"}
                      </div>
                    </div>
                    <span className={`badge ${p.status as PlateStatus} marquee`}>{p.status}</span>
                  </div>

                  <div className="plate-tags">
                    <span className="tag">{p.targetPrinterModel ?? "unassigned"}</span>
                    <span className="tag mono">{p.nozzle}mm nozzle</span>
                    <span className="tag">{p.plateType ?? DEFAULT_PLATE} plate</span>
                  </div>

                  <div className="plate-metrics">
                    <div className="metric">
                      <div className="metric-num">{roll?.units ?? 0}</div>
                      <div className="metric-label">Units</div>
                    </div>
                    <div className="metric">
                      <div className="metric-num">{p.estGrams != null ? `${p.estGrams}g` : "-"}</div>
                      <div className="metric-label">Filament</div>
                    </div>
                    <div className="metric">
                      <div className="metric-num">
                        {p.estMinutes != null ? fmtDuration(p.estMinutes) : "-"}
                      </div>
                      <div className="metric-label">Print time</div>
                    </div>
                  </div>

                  <ul className="plate-items">
                    {items.map((it) => (
                      <li key={`${it.label}||${it.partType}`}>
                        <span>
                          {it.label}
                          {it.partType !== "print" ? (
                            <span className="muted mono"> · {it.partType}</span>
                          ) : null}
                        </span>
                        <span className="qty">×{it.units}</span>
                      </li>
                    ))}
                  </ul>

                  {p.status === "failed" && p.errorText ? (
                    <div style={{ padding: "0 16px 14px" }}>
                      <span className="reason">{p.errorText}</span>
                    </div>
                  ) : null}
                  {p.status === "sliced" && p.artifactFilename ? (
                    <div style={{ padding: "0 16px 14px" }}>
                      <span className="muted mono">{p.artifactFilename}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <h2>Filament groups</h2>
      {plateList.length === 0 ? (
        <div className="empty">
          No ready jobs yet. Sync orders, then resolve any that need review.
        </div>
      ) : (
        <div className="plate-grid">
          {plateList.map((p) => {
            const items = [...p.items.values()].sort((a, b) => b.units - a.units);
            // readyUnits already excludes missing-model units (can't slice a
            // file we don't have), so it is exactly what will be composed.
            const composable = p.readyUnits;
            return (
              <div className="plate" key={p.key}>
                <div className="plate-head">
                  <span
                    className="plate-swatch"
                    style={{ background: p.hex ?? "transparent" }}
                    aria-hidden
                  />
                  <div>
                    <div className="plate-title">
                      {p.material} · {p.color}
                    </div>
                    <div className="plate-sub">
                      {p.jobCount} job{p.jobCount === 1 ? "" : "s"}
                      {p.hex ? null : " · no swatch on record"}
                    </div>
                  </div>
                  {p.missingModelUnits > 0 ? (
                    <span className="flag marquee" title="Some jobs have no model file on record">
                      {p.missingModelUnits} no model
                    </span>
                  ) : null}
                </div>

                <div className="plate-tags">
                  <span className="tag mono">{p.nozzle}mm nozzle</span>
                  <span className="tag">{p.plateType} plate</span>
                  {p.hardened ? (
                    <span className="tag warn" title="Abrasive filament: hardened nozzle required">
                      hardened
                    </span>
                  ) : null}
                  {p.needsEnclosure ? (
                    <span className="tag warn" title="Filament prefers an enclosure">
                      enclosure
                    </span>
                  ) : null}
                </div>

                <div className="plate-metrics">
                  <div className="metric">
                    <div className="metric-num">{p.totalUnits}</div>
                    <div className="metric-label">Units</div>
                  </div>
                  <div className="metric">
                    <div className="metric-num">{p.hasEstimates ? `${p.estGrams}g` : "-"}</div>
                    <div className="metric-label">Est. filament</div>
                  </div>
                  <div className="metric">
                    <div className="metric-num">
                      {p.hasEstimates ? fmtDuration(p.estMinutes) : "-"}
                    </div>
                    <div className="metric-label">Est. time</div>
                  </div>
                </div>

                <ul className="plate-items">
                  {items.map((it) => (
                    <li key={`${it.label}||${it.partType}`}>
                      <span>
                        {it.label}
                        {it.partType !== "print" ? (
                          <span className="muted mono"> · {it.partType}</span>
                        ) : null}
                        {it.missingModel ? <span className="flag" style={{ marginLeft: 6 }}>no model</span> : null}
                      </span>
                      <span className="qty">×{it.units}</span>
                    </li>
                  ))}
                </ul>

                {composable > 0 ? (
                  <div className="plate-foot">
                    <form action={composePlatesForGroup}>
                      <input type="hidden" name="groupKey" value={p.key} />
                      <button type="submit" className="primary">
                        Compose {composable} unit{composable === 1 ? "" : "s"}
                      </button>
                    </form>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
