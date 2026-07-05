import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { importListing } from "@/lib/catalog/import-files";
import { checkWorkerAuth } from "@/lib/worker/auth";

export const dynamic = "force-dynamic";

/**
 * Register the STL library from a listing uploaded in the request body. Runs the
 * DB write on the server (which can reach the DB) so clients that can't reach
 * Postgres directly can still import. Body is the raw listing text (one path per
 * line); auth reuses the WORKER_TOKEN bearer.
 *
 *   curl -X POST "$SERVER/api/admin/import-files" \
 *     -H "authorization: Bearer $WORKER_TOKEN" \
 *     --data-binary @stl-files.txt
 */
export async function POST(request: Request) {
  const auth = checkWorkerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const text = await request.text();
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "empty listing body" }, { status: 400 });
  }

  const db = getDb();
  const result = await importListing(db, text);
  return NextResponse.json({ ok: true, ...result });
}
