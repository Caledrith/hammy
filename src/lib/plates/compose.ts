import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { getDb, type Database } from "../../db";
import {
  filamentMap,
  orderLineItems,
  orders,
  plateJobs,
  plates,
  printableFiles,
  printers,
  printJobs,
} from "../../db/schema";
import {
  filamentKey,
  plateGroupKey,
  resolveNozzle,
  resolvePlateType,
  type FilamentSpec,
} from "./grouping";

// Coarse per-bed unit capacity, used only to decide how many part instances to
// feed one CLI invocation. The slicer's own auto-arrange is the ground truth for
// what actually fits; overflow comes back in the worker's slice report. Bigger
// beds (H2) hold more. Tune once real footprints are known.
const MODEL_CAPACITY: Record<string, number> = {
  P1S: 16,
  P2S: 16,
  X1C: 16,
  A1: 16,
  H2: 30,
};
const DEFAULT_CAPACITY = 16;

// Preference order when multiple printer models can run a plate. P1S is the
// workhorse, so it wins ties and is the fallback when nothing else matches.
const MODEL_PREFERENCE = ["P1S", "P2S", "X1C", "A1", "H2"];
const DEFAULT_MODEL = "P1S";

const NOZZLE_TOLERANCE = 0.001;

export interface ComposeResult {
  groupKey: string;
  platesCreated: number;
  jobsPlaced: number;
  unitsPlaced: number;
}

interface CandidateJob {
  id: number;
  quantity: number;
  slicerProfile: string | null;
  material: string;
  color: string;
  colorHex: string | null;
  nozzle: number;
  plateType: string;
  groupKey: string;
}

/**
 * Pick the printer model best able to run this filament + nozzle + plate. Filters
 * enabled printers by capability (nozzle match, enclosure, hardened nozzle),
 * then prefers the model with the most matching printers. Falls back to P1S when
 * the fleet is empty or nothing matches, leaving the operator to sort it out.
 */
async function chooseTargetModel(
  db: Database,
  nozzle: number,
  spec: FilamentSpec | undefined,
): Promise<string> {
  const fleet = await db.select().from(printers).where(eq(printers.enabled, true));
  if (fleet.length === 0) return DEFAULT_MODEL;

  const needsEnclosure = spec?.needsEnclosure ?? false;
  const needsHardened = spec?.hardened ?? false;

  const matches = fleet.filter((p) => {
    if (Math.abs(p.nozzleDiameter - nozzle) > NOZZLE_TOLERANCE) return false;
    if (needsEnclosure && !p.hasEnclosure) return false;
    if (needsHardened && !p.supportsHardened) return false;
    return true;
  });
  if (matches.length === 0) return DEFAULT_MODEL;

  const countByModel = new Map<string, number>();
  for (const p of matches) countByModel.set(p.model, (countByModel.get(p.model) ?? 0) + 1);

  return [...countByModel.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ai = MODEL_PREFERENCE.indexOf(a[0]);
    const bi = MODEL_PREFERENCE.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  })[0][0];
}

function capacityFor(model: string): number {
  return Math.max(1, MODEL_CAPACITY[model] ?? DEFAULT_CAPACITY);
}

/**
 * Compose the ready, sliceable print jobs of one plate group into one or more
 * draft plates. Only jobs with a resolved printable file are placed (you can't
 * slice a model you don't have); jobs missing a file stay ready and surface on
 * the dashboard. Placed jobs move ready -> assigned inside the same transaction.
 */
export async function composePlates(groupKey: string): Promise<ComposeResult> {
  const db = getDb();

  const filaments = await db
    .select({
      material: filamentMap.materialOption,
      color: filamentMap.colorOption,
      hex: filamentMap.colorHex,
      defaultPlateType: filamentMap.defaultPlateType,
      hardened: filamentMap.hardenedNozzle,
      needsEnclosure: filamentMap.needsEnclosure,
      slicerProfile: filamentMap.slicerProfile,
    })
    .from(filamentMap);

  const specByFilament = new Map<string, FilamentSpec & { slicerProfile: string | null }>();
  for (const f of filaments) {
    specByFilament.set(filamentKey(f.material ?? "", f.color ?? ""), {
      hex: f.hex,
      defaultPlateType: f.defaultPlateType,
      hardened: f.hardened,
      needsEnclosure: f.needsEnclosure,
      slicerProfile: f.slicerProfile,
    });
  }

  // Ready jobs that have a real file to slice, oldest orders first within a
  // priority tier (so aging orders drain before newer ones).
  const rows = await db
    .select({
      id: printJobs.id,
      quantity: printJobs.quantity,
      material: printJobs.materialOption,
      color: printJobs.colorOption,
      colorHex: printJobs.colorHex,
      slicerProfile: printJobs.slicerProfile,
      fileNozzle: printableFiles.nozzleDiameter,
      filePlateType: printableFiles.plateType,
    })
    .from(printJobs)
    .innerJoin(printableFiles, eq(printJobs.printableFileId, printableFiles.id))
    .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(and(eq(printJobs.status, "ready"), isNotNull(printJobs.printableFileId)))
    .orderBy(desc(printJobs.priority), asc(orders.processedAt), asc(printJobs.id));

  const candidates: CandidateJob[] = [];
  for (const r of rows) {
    const material = r.material ?? "Unknown";
    const color = r.color ?? "Unknown";
    const spec = specByFilament.get(filamentKey(material, color));
    const nozzle = resolveNozzle(r.fileNozzle);
    const plateType = resolvePlateType(r.filePlateType, spec);
    const key = plateGroupKey(material, color, nozzle, plateType);
    if (key !== groupKey) continue;
    candidates.push({
      id: r.id,
      quantity: r.quantity,
      slicerProfile: r.slicerProfile,
      material,
      color,
      colorHex: r.colorHex,
      nozzle,
      plateType,
      groupKey: key,
    });
  }

  const empty: ComposeResult = { groupKey, platesCreated: 0, jobsPlaced: 0, unitsPlaced: 0 };
  if (candidates.length === 0) return empty;

  const head = candidates[0];
  const spec = specByFilament.get(filamentKey(head.material, head.color));
  const targetModel = await chooseTargetModel(db, head.nozzle, spec);
  const capacity = capacityFor(targetModel);
  const slicerProfile = head.slicerProfile ?? spec?.slicerProfile ?? null;
  const colorHex = head.colorHex ?? spec?.hex ?? null;

  // Greedy first-fit: pour each job's units into the current plate until it hits
  // capacity, opening a new plate as needed. A job can straddle plates.
  type Bucket = Map<number, { units: number }>;
  const buckets: Bucket[] = [];
  let current: Bucket = new Map();
  let currentUnits = 0;
  buckets.push(current);

  for (const job of candidates) {
    let remaining = job.quantity;
    while (remaining > 0) {
      if (currentUnits >= capacity) {
        current = new Map();
        currentUnits = 0;
        buckets.push(current);
      }
      const place = Math.min(remaining, capacity - currentUnits);
      const existing = current.get(job.id);
      if (existing) existing.units += place;
      else current.set(job.id, { units: place });
      currentUnits += place;
      remaining -= place;
    }
  }

  const filledBuckets = buckets.filter((b) => b.size > 0);
  const jobIds = candidates.map((c) => c.id);

  await db.transaction(async (tx) => {
    for (const bucket of filledBuckets) {
      const [plate] = await tx
        .insert(plates)
        .values({
          status: "draft",
          groupKey,
          materialOption: head.material,
          colorOption: head.color,
          colorHex,
          nozzle: head.nozzle,
          plateType: head.plateType,
          slicerProfile,
          targetPrinterModel: targetModel,
        })
        .returning({ id: plates.id });

      await tx.insert(plateJobs).values(
        [...bucket.entries()].map(([printJobId, { units }]) => ({
          plateId: plate.id,
          printJobId,
          quantity: units,
        })),
      );
    }

    // Every ready job in the group is fully placed, so mark them all assigned.
    for (const id of jobIds) {
      await tx
        .update(printJobs)
        .set({ status: "assigned", updatedAt: new Date() })
        .where(eq(printJobs.id, id));
    }
  });

  const unitsPlaced = candidates.reduce((a, c) => a + c.quantity, 0);
  return {
    groupKey,
    platesCreated: filledBuckets.length,
    jobsPlaced: candidates.length,
    unitsPlaced,
  };
}
