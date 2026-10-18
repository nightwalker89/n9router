import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateWindow } from "@/lib/usageLimiter.js";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, limits, name, access } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      updateData.name = trimmed;
    }

    // Handle limits update
    if (limits !== undefined) {
      if (limits === null) {
        // Clear all limits
        updateData.limits = null;
      } else if (typeof limits === "object") {
        const LIMIT_FIELDS = ["inputTokens5h", "inputTokens24h", "cost5h", "cost24h"];
        const validLimits = { ...(existing.limits || {}) };

        // Handle legacy 5h/24h fields
        for (const field of LIMIT_FIELDS) {
          if (!(field in limits)) continue;
          const val = limits[field];
          if (val === null || val === 0) {
            validLimits[field] = null; // null = unlimited
          } else if (typeof val === "number" && val > 0) {
            validLimits[field] = val;
          } else {
            return NextResponse.json(
              { error: `Invalid limit value for ${field}: must be null or positive number` },
              { status: 400 }
            );
          }
        }

        // Handle custom time windows
        if ("windows" in limits) {
          if (limits.windows === null) {
            validLimits.windows = null;
          } else if (Array.isArray(limits.windows)) {
            const validWindows = [];
            for (const win of limits.windows) {
              const validation = validateWindow(win);
              if (!validation.valid) {
                return NextResponse.json(
                  { error: `Invalid window: ${validation.error}` },
                  { status: 400 }
                );
              }
              validWindows.push({
                durationMs: win.durationMs,
                label: win.label || formatDurationLabel(win.durationMs),
                inputTokens: win.inputTokens || null,
                cost: win.cost || null,
              });
            }
            validLimits.windows = validWindows.length > 0 ? validWindows : null;
          } else {
            return NextResponse.json(
              { error: "windows must be an array or null" },
              { status: 400 }
            );
          }
        }

        // Check if all limits are cleared
        const hasLegacyLimits = LIMIT_FIELDS.some((f) => validLimits[f]);
        const hasWindows = validLimits.windows && validLimits.windows.length > 0;
        updateData.limits = hasLegacyLimits || hasWindows ? validLimits : null;
      }
    }

    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}


// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}

/**
 * Format duration in milliseconds to human-readable label.
 * @param {number} ms
 * @returns {string}
 */
function formatDurationLabel(ms) {
  const minutes = Math.floor(ms / (60 * 1000));
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days} day${days > 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  return `${minutes} min`;
}
