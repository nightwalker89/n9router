import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";

const HEALTH_FILE = path.join(DATA_DIR, "account-health.json");
const MAX_EVENTS = 100;
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

// Compact → expanded status names for dashboard consumption
const STATUS_EXPAND = {
  ok: "success",
  rs: "retry_success",
  fl: "fail",
};

// Expanded → compact (for POST writes)
const STATUS_CODE = {
  success:       "ok",
  retry_success: "rs",
  fail:          "fl",
};

function readStore() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return {};
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeStore(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(data));
  } catch { /* ignore */ }
}

/**
 * Expand compact event format for dashboard consumption.
 * { ts, s, a, m? } → { ts, status, attempts, model? }
 */
function expandEvents(events) {
  return (events || []).map((e) => ({
    ts: e.ts,
    status: STATUS_EXPAND[e.s] || e.s,
    attempts: e.a,
    ...(e.m && { model: e.m }),
  }));
}

/**
 * POST /api/internal/account-health
 * Receives a health event from the MITM process (fallback path).
 * Primary writes happen via healthStore.js (direct fs write from MITM).
 *
 * Body: { connectionId, status, attempts?, model? }
 */
export async function POST(request) {
  if (request.headers.get(INTERNAL_REQUEST_HEADER.name) !== INTERNAL_REQUEST_HEADER.value) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { connectionId, status, attempts, model } = body ?? {};

    if (!connectionId || !status || !STATUS_CODE[status]) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    const store = readStore();
    if (!store[connectionId]) store[connectionId] = [];

    const event = {
      ts: Date.now(),
      s: STATUS_CODE[status],
      a: attempts || 1,
    };
    if (model) event.m = model;

    store[connectionId].push(event);
    if (store[connectionId].length > MAX_EVENTS) {
      store[connectionId] = store[connectionId].slice(-MAX_EVENTS);
    }

    writeStore(store);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message || "failed" }, { status: 500 });
  }
}

/**
 * GET /api/internal/account-health
 * Returns health events for the dashboard.
 *
 * ?connectionId=abc-123  → { events: [...] }   (single account)
 * (no param)             → { accounts: {...} }  (all accounts)
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const connectionId = searchParams.get("connectionId");

  const store = readStore();

  if (connectionId) {
    return NextResponse.json({ events: expandEvents(store[connectionId]) });
  }

  // All accounts
  const accounts = {};
  for (const [id, events] of Object.entries(store)) {
    accounts[id] = expandEvents(events);
  }
  return NextResponse.json({ accounts });
}
