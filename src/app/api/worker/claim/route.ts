import { NextResponse } from "next/server";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  orderLineItems,
  orders,
  plateJobs,
  plates,
  printableFiles,
  printJobs,
} from "@/db/schema";
import { checkWorkerAuth } from "@/lib/worker/auth";
import type { ClaimResponse } from "@/lib/worker/types";

export const dynamic = "force-dynamic";

// A claimed plate whose worker goes silent for this long is fair game to
// reclaim, so a crashed slice doesn't strand the plate forever.
const CLAIM_LEASE_MS = 15 * 60 * 1000;

function normalizePath(p: string | null): string {
  return (p ?? "").replace(/\\/g, "/");
}

async function claim(request: Request) {
  const auth = checkWorkerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = getDb();
  const staleThreshold = new Date(Date.now() - CLAIM_LEASE_MS);

  // Atomically grab the oldest queued (or stale-claimed) plate. FOR UPDATE SKIP
  // LOCKED lets multiple workers poll without handing the same plate out twice.
  const plateId = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: plates.id })
      .from(plates)
      .where(
        or(
          eq(plates.status, "draft"),
          and(eq(plates.status, "claimed"), lt(plates.claimedAt, staleThreshold)),
        ),
      )
      .orderBy(asc(plates.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) return null;

    await tx
      .update(plates)
      .set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
      .where(eq(plates.id, candidate.id));

    return candidate.id;
  });

  if (plateId == null) {
    const body: ClaimResponse = { plate: null };
    return NextResponse.json(body);
  }

  const [plate] = await db.select().from(plates).where(eq(plates.id, plateId)).limit(1);

  const fileRows = await db
    .select({
      printJobId: printJobs.id,
      path: printableFiles.filePath,
      partType: printJobs.partType,
      quantity: plateJobs.quantity,
      orderName: orders.name,
      title: orderLineItems.title,
    })
    .from(plateJobs)
    .innerJoin(printJobs, eq(plateJobs.printJobId, printJobs.id))
    .leftJoin(printableFiles, eq(printJobs.printableFileId, printableFiles.id))
    .leftJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(eq(plateJobs.plateId, plateId));

  const body: ClaimResponse = {
    plate: {
      id: plate.id,
      material: plate.materialOption,
      color: plate.colorOption,
      nozzle: plate.nozzle,
      plateType: plate.plateType,
      slicerProfile: plate.slicerProfile,
      targetPrinterModel: plate.targetPrinterModel,
      files: fileRows.map((f) => ({
        printJobId: f.printJobId,
        path: normalizePath(f.path),
        partType: f.partType,
        quantity: f.quantity,
        label: f.orderName ?? f.title ?? null,
      })),
    },
  };
  return NextResponse.json(body);
}

export const POST = claim;
