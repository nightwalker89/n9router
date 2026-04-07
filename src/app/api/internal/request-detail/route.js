import { NextResponse } from "next/server";
import { getRequestDetailById, saveRequestDetail } from "@/lib/usageDb";

const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

function mergeObjects(existingValue, incomingValue) {
  if (!incomingValue || typeof incomingValue !== "object" || Array.isArray(incomingValue)) {
    return incomingValue ?? existingValue;
  }

  return {
    ...(existingValue && typeof existingValue === "object" && !Array.isArray(existingValue) ? existingValue : {}),
    ...incomingValue
  };
}

export async function POST(request) {
  if (request.headers.get(INTERNAL_REQUEST_HEADER.name) !== INTERNAL_REQUEST_HEADER.value) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    if (!body?.id) {
      return NextResponse.json({ error: "missing id" }, { status: 400 });
    }

    const existing = await getRequestDetailById(body.id);
    const detail = existing ? {
      ...existing,
      ...body,
      latency: mergeObjects(existing.latency, body.latency),
      tokens: mergeObjects(existing.tokens, body.tokens),
      request: mergeObjects(existing.request, body.request),
      providerRequest: mergeObjects(existing.providerRequest, body.providerRequest),
      providerResponse: body.providerResponse ?? existing.providerResponse,
      response: mergeObjects(existing.response, body.response),
    } : body;

    await saveRequestDetail(detail);
    return NextResponse.json({ ok: true, id: detail.id });
  } catch (error) {
    return NextResponse.json({ error: error.message || "failed to persist request detail" }, { status: 500 });
  }
}
