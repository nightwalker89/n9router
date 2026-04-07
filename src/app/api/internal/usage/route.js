import { NextResponse } from "next/server";
import { saveRequestUsage, appendRequestLog } from "@/lib/usageDb";

const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", tokens.prompt_tokens ?? tokens.input_tokens);
  assignNumber("completion_tokens", tokens.completion_tokens ?? tokens.output_tokens);
  assignNumber("total_tokens", tokens.total_tokens);
  assignNumber("cache_read_input_tokens", tokens.cache_read_input_tokens ?? tokens.cached_tokens);
  assignNumber("cache_creation_input_tokens", tokens.cache_creation_input_tokens);
  assignNumber("reasoning_tokens", tokens.reasoning_tokens);

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export async function POST(request) {
  if (request.headers.get(INTERNAL_REQUEST_HEADER.name) !== INTERNAL_REQUEST_HEADER.value) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const tokens = normalizeTokens(body?.tokens);

    if (!body?.provider || !body?.model || !body?.connectionId || !tokens) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    await saveRequestUsage({
      provider: body.provider,
      model: body.model,
      connectionId: body.connectionId,
      tokens,
      timestamp: new Date().toISOString()
    });

    await appendRequestLog({
      model: body.model,
      provider: body.provider,
      connectionId: body.connectionId,
      tokens,
      status: body.status || "200 OK"
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message || "failed to persist usage" }, { status: 500 });
  }
}
