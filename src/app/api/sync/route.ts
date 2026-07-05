import { NextResponse } from "next/server";
import { syncOrders } from "@/lib/ingest";

export const dynamic = "force-dynamic";

async function run() {
  try {
    const result = await syncOrders();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// POST for triggering a sync; GET provided as a convenience for simple cron pings.
export const POST = run;
export const GET = run;
