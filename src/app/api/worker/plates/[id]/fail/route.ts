import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { plateJobs, plates, printJobs } from "@/db/schema";
import { checkWorkerAuth } from "@/lib/worker/auth";
import type { FailRequest } from "@/lib/worker/types";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = checkWorkerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { id } = await params;
  const plateId = Number(id);
  if (!Number.isInteger(plateId)) {
    return NextResponse.json({ ok: false, error: "invalid plate id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as Partial<FailRequest>;
  const reason = (body.reason ?? "slice failed").toString().slice(0, 500);
  const detail = body.detail ? body.detail.toString().slice(0, 4000) : null;
  const errorText = detail ? `${reason}\n\n${detail}` : reason;

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [plate] = await tx
      .update(plates)
      .set({ status: "failed", errorText, updatedAt: new Date() })
      .where(eq(plates.id, plateId))
      .returning({ id: plates.id });
    if (!plate) return null;

    // Free this plate's jobs so they can be recomposed, then detach them so a
    // recompose can't double-place them. (A job split across a failed and a
    // sliced plate is a rare edge left for manual review.)
    const members = await tx
      .select({ printJobId: plateJobs.printJobId })
      .from(plateJobs)
      .where(eq(plateJobs.plateId, plateId));
    const jobIds = members.map((m) => m.printJobId);
    if (jobIds.length > 0) {
      await tx
        .update(printJobs)
        .set({ status: "ready", updatedAt: new Date() })
        .where(inArray(printJobs.id, jobIds));
      await tx.delete(plateJobs).where(eq(plateJobs.plateId, plateId));
    }
    return { requeued: jobIds.length };
  });

  if (!result) {
    return NextResponse.json({ ok: false, error: "plate not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...result });
}
