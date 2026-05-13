import { NextResponse } from "next/server";
import { getApiKeyUsageReport } from "@/lib/usageReportDb";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d", "all", "custom"]);
const VALID_GROUP_BY = new Set(["apiKey", "model", "provider", "time", "all", "none"]);
const VALID_SERIES_BY = new Set(["apiKey", "model", "provider", "none"]);
const VALID_INTERVALS = new Set(["hour", "day", "week", "month"]);
const VALID_METRICS = new Set(["requests", "tokens", "cost", "cachedTokens"]);

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

function parseAndValidateParams(searchParams) {
  const period = searchParams.get("period") || "7d";
  if (!VALID_PERIODS.has(period)) throw bad(`Invalid period: ${period}`);

  const filters = { period };

  if (period === "custom") {
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    if (!startDate || !endDate) throw bad("Custom period requires startDate and endDate");
    if (isNaN(new Date(startDate).getTime()) || isNaN(new Date(endDate).getTime())) throw bad("Invalid date format");
    if (new Date(startDate) > new Date(endDate)) throw bad("startDate must be before endDate");
    filters.startDate = startDate;
    filters.endDate = endDate;
  }

  const groupBy = searchParams.get("groupBy");
  if (groupBy) {
    if (!VALID_GROUP_BY.has(groupBy)) throw bad(`Invalid groupBy: ${groupBy}`);
    // "all" → aggregate mode: use apiKey for breakdown, none for series
    filters.groupBy = groupBy === "all" ? "apiKey" : (groupBy === "none" ? "apiKey" : groupBy);
    if (groupBy === "all") filters.seriesBy = "none";
  }

  const seriesBy = searchParams.get("seriesBy");
  if (seriesBy) {
    if (!VALID_SERIES_BY.has(seriesBy)) throw bad(`Invalid seriesBy: ${seriesBy}`);
    filters.seriesBy = seriesBy;
  }

  const interval = searchParams.get("interval");
  if (interval) {
    if (!VALID_INTERVALS.has(interval)) throw bad(`Invalid interval: ${interval}`);
    filters.interval = interval;
  }

  const metric = searchParams.get("metric");
  if (metric) {
    if (!VALID_METRICS.has(metric)) throw bad(`Invalid metric: ${metric}`);
    filters.metric = metric;
  }

  const limitStr = searchParams.get("limit");
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (isNaN(limit)) throw bad("Invalid limit");
    filters.limit = Math.max(1, Math.min(100, limit));
  }

  const apiKeyIds = searchParams.get("apiKeyIds");
  if (apiKeyIds) filters.apiKeyIds = apiKeyIds.split(",").map((s) => s.trim()).filter(Boolean);

  const models = searchParams.get("models");
  if (models) filters.models = models.split(",").map((s) => s.trim()).filter(Boolean);

  const providers = searchParams.get("providers");
  if (providers) filters.providers = providers.split(",").map((s) => s.trim()).filter(Boolean);

  return filters;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseAndValidateParams(searchParams);
    const report = await getApiKeyUsageReport(filters);
    return NextResponse.json(report);
  } catch (error) {
    if (error.status === 400) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[API] Failed to get usage report:", error);
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}
