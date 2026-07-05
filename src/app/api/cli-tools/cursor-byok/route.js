import { NextResponse } from "next/server";
import { getCursorByokStatus } from "@/lib/cursorByok/status";

export const runtime = "nodejs";

function getErrorMessage(error, fallback) {
  return error?.message || fallback;
}

export async function GET() {
  try {
    return NextResponse.json(await getCursorByokStatus());
  } catch (error) {
    console.error("[cursor-byok] get status failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to get Cursor BYOK status") },
      { status: 500 },
    );
  }
}
