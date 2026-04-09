export const ANTIGRAVITY_ACCOUNT_TYPES = ["Free", "Pro", "Ultra"];

export const ANTIGRAVITY_ACCOUNT_TYPE_OPTIONS = ANTIGRAVITY_ACCOUNT_TYPES.map((value) => ({
  value,
  label: value,
}));

export function normalizeAntigravityAccountType(input) {
  if (input == null) return null;

  const value = String(input).trim();
  if (!value) return null;

  const normalized = value.toLowerCase();

  if (normalized.includes("ultra")) return "Ultra";
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("free")) return "Free";

  return null;
}

export function inferAntigravityAccountType(source) {
  if (!source) return null;

  if (typeof source === "string") {
    return normalizeAntigravityAccountType(source);
  }

  const candidates = [
    source.accountType,
    source.plan,
    source.paidTier?.name,
    source.subscriptionTier,
    source.subscription_tier,
    source.currentTier?.name,
    source.subscriptionInfo?.paidTier?.name,
    source.quota?.subscription_tier,
    source.subscriptionInfo?.currentTier?.name,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAntigravityAccountType(candidate);
    if (normalized) return normalized;
  }

  return null;
}
