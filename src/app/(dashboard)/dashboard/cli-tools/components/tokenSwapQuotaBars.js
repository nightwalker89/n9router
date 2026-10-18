// Compact quota bars for Token Rotation pool accounts: Claude (left) and Gemini (right),
// each with a 5h and a weekly row. Keys come from parseQuotaData("antigravity", ...);
// the plain "claude"/"gemini" rows are its fallback when the 5h summary is missing.
const QUOTA_FAMILIES = [
  { family: "Claude", session: ["claude_gpt_session", "claude"], weekly: ["claude_gpt_weekly"] },
  { family: "Gemini", session: ["gemini_session", "gemini"], weekly: ["gemini_weekly"] },
];

/**
 * @param {Array<Object>} quotas - Normalized quotas from parseQuotaData
 * @returns {Array<{ family: string, rows: Array<{ window: "5h"|"Wk", quota: Object|null }> }>}
 */
export function pickQuotaFamilyBars(quotas = []) {
  const byKey = new Map(quotas.map((quota) => [quota.modelKey, quota]));
  const pick = (keys) => keys.map((key) => byKey.get(key)).find(Boolean) || null;
  return QUOTA_FAMILIES.map(({ family, session, weekly }) => ({
    family,
    rows: [
      { window: "5h", quota: pick(session) },
      { window: "Wk", quota: pick(weekly) },
    ],
  }));
}
