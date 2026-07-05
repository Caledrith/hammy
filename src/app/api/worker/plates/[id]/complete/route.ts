import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plates } from "@/db/schema";
import { checkWorkerAuth } from "@/lib/worker/auth";
import type { CompleteRequest } from "@/lib/worker/types";

export const dynamic = "force-dynamic";

function toIntOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

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

  const body = (await request.json().catch(() => ({}))) as CompleteRequest;

  const db = getDb();
  const [updated] = await db
    .update(plates)
    .set({
      status: "sliced",
      estMinutes: toIntOrNull(body.estMinutes),
      estGrams: toIntOrNull(body.estGrams),
      objectCount: toIntOrNull(body.objectCount),
      artifactFilename: body.artifactFilename ?? null,
      errorText: null,
      updatedAt: new Date(),
    })
    .where(eq(plates.id, plateId))
    .returning({ id: plates.id });

  if (!updated) {
    return NextResponse.json({ ok: false, error: "plate not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
