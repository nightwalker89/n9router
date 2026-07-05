import { NextResponse } from "next/server";
import { createCursorByokJob } from "@/lib/cursorByok/jobs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || "install";
    const job = createCursorByokJob(action);
    return NextResponse.json({ job });
  } catch (error) {
    const status = Number(error?.statusCode) || 400;
    return NextResponse.json(
      { error: error?.message || "Failed to start Cursor BYOK job" },
      { status },
    );
  }
}
