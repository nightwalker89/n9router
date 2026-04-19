const { log, err } = require("../logger");

const DEFAULT_LOCAL_ROUTER = "http://localhost:20128";
const ROUTER_BASE = String(process.env.MITM_ROUTER_BASE || DEFAULT_LOCAL_ROUTER)
  .trim()
  .replace(/\/+$/, "") || DEFAULT_LOCAL_ROUTER;
const API_KEY = process.env.ROUTER_API_KEY;

// Headers that must not be forwarded to 9Router
const STRIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "content-type", "authorization"
]);

/**
 * Send body to 9Router at the given path and return the fetch Response object.
 * Optionally forwards client headers (stripped of hop-by-hop / overridden keys).
 */
async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}) {
  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  const response = await fetch(`${ROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(API_KEY && { "Authorization": `Bearer ${API_KEY}` })
    },
    body: JSON.stringify(openaiBody)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`[${response.status}]: ${errText}`);
  }

  return response;
}

/**
 * Pipe SSE stream from router directly to client response
 */
async function pipeSSE(routerRes, res, debugContext = null) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(200, resHeaders);

  if (!routerRes.body) {
    const bodyText = await routerRes.text().catch(() => "");
    res.end(bodyText);
    debugContext?.logResponse({
      statusCode: routerRes.status,
      headers: routerRes.headers,
      bodyBuffer: Buffer.from(bodyText),
      streamed: false,
      note: "9Router mapped response",
    });
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      res.end();
      debugContext?.logResponse({
        statusCode: routerRes.status,
        headers: routerRes.headers,
        bodyBuffer: Buffer.concat(chunks),
        streamed: ct.includes("text/event-stream"),
        note: "9Router mapped response",
      });
      break;
    }
    chunks.push(Buffer.from(value));
    res.write(decoder.decode(value, { stream: true }));
  }
}

module.exports = { fetchRouter, pipeSSE };
