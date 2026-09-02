export const DEFAULT_EXPECTED_ANALYTICS_DELIVERY = "durable-outbox";
export const REVIEWED_ANALYTICS_DELIVERY_POLICIES = Object.freeze([
  "best-effort",
  "durable-outbox",
]);
export const OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT = 64;

const reviewedAnalyticsDeliveryPolicies = new Set(REVIEWED_ANALYTICS_DELIVERY_POLICIES);

export function resolveExpectedAnalyticsDelivery(commandLineValue, environmentValue) {
  const configuredValue = commandLineValue === undefined
    ? environmentValue
    : commandLineValue;
  if (configuredValue === undefined) return DEFAULT_EXPECTED_ANALYTICS_DELIVERY;
  if (typeof configuredValue === "string"
    && reviewedAnalyticsDeliveryPolicies.has(configuredValue)) {
    return configuredValue;
  }
  throw new TypeError(
    "The expected analytics delivery policy (second CLI argument or "
      + "NONSTOPTALK_EXPECTED_ANALYTICS_DELIVERY) must be exactly "
      + '"best-effort" or "durable-outbox" when set.',
  );
}

export function formatObservedAnalyticsDelivery(value) {
  if (typeof value !== "string") return "<missing or non-string>";
  const preview = value
    .slice(0, OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT)
    .replace(/[^\x20-\x7e]|["\\]/gu, "?");
  const suffix = value.length > OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT ? "…" : "";
  return `"${preview}${suffix}"`;
}

export function assertExpectedAnalyticsDelivery(observedValue, expectedValue) {
  if (!reviewedAnalyticsDeliveryPolicies.has(expectedValue)) {
    throw new TypeError("expectedValue must be a reviewed analytics delivery policy");
  }
  if (observedValue !== expectedValue) {
    throw new Error(
      `aggregate analytics delivery mismatch: expected ${JSON.stringify(expectedValue)}, `
        + `observed ${formatObservedAnalyticsDelivery(observedValue)}`,
    );
  }
  return observedValue;
}
