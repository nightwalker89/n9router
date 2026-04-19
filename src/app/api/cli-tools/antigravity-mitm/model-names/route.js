"use server";

import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/models";
import { MITM_TOOLS } from "@/shared/constants/cliTools";
import {
  normalizeMitmModelNameOverrides,
  normalizeMitmModelNameSettings,
} from "@/lib/mitmModelNames";

const SUPPORTED_TOOLS = new Set(["antigravity"]);

function getToolConfig(tool) {
  if (!SUPPORTED_TOOLS.has(tool)) return null;
  return MITM_TOOLS[tool] || null;
}

function getAllowedModelIds(toolConfig) {
  return (toolConfig?.defaultModels || [])
    .map((model) => model?.alias || model?.id)
    .filter(Boolean);
}

function normalizeTool(input) {
  return typeof input === "string" ? input.trim() : "";
}

function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const tool = normalizeTool(searchParams.get("tool") || "antigravity");
    const toolConfig = getToolConfig(tool);

    if (!toolConfig) {
      return badRequest("Unsupported MITM tool");
    }

    const settings = await getSettings();
    const allOverrides = normalizeMitmModelNameSettings(settings);
    const overrides = normalizeMitmModelNameOverrides(
      allOverrides[tool],
      getAllowedModelIds(toolConfig)
    );

    return NextResponse.json({ tool, overrides });
  } catch (error) {
    console.log("Error fetching MITM model name overrides:", error.message);
    return NextResponse.json({ error: "Failed to fetch model name overrides" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const tool = normalizeTool(body?.tool);
    const toolConfig = getToolConfig(tool);

    if (!toolConfig) {
      return badRequest("Unsupported MITM tool");
    }

    if (!body?.overrides || typeof body.overrides !== "object" || Array.isArray(body.overrides)) {
      return badRequest("tool and overrides required");
    }

    const settings = await getSettings();
    const allOverrides = normalizeMitmModelNameSettings(settings);
    const overrides = normalizeMitmModelNameOverrides(
      body.overrides,
      getAllowedModelIds(toolConfig)
    );

    const nextOverrides = {
      ...allOverrides,
      [tool]: overrides,
    };

    await updateSettings({ mitmModelNameOverrides: nextOverrides });

    return NextResponse.json({
      success: true,
      tool,
      overrides,
    });
  } catch (error) {
    console.log("Error saving MITM model name overrides:", error.message);
    return NextResponse.json({ error: "Failed to save model name overrides" }, { status: 500 });
  }
}
