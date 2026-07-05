import { NextResponse } from "next/server";
import { provideCursorByokSudo } from "@/lib/cursorByok/jobs";

export const runtime = "nodejs";

export async function POST(request, { params }) {
  try {
    const { jobId } = await params;
    const body = await request.json().catch(() => ({}));
    const job = provideCursorByokSudo(jobId, body.sudoPassword || "");
    return NextResponse.json({ job });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    return NextResponse.json(
      { error: error?.message || "Failed to submit sudo password" },
      { status },
    );
  }
}
