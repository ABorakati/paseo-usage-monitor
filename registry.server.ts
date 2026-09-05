import {
  UsageProviderSchema,
  type UsageProvider,
  type UsageProviderOverride,
  type UsageProviderOverrides,
} from "./limits.shared";
import { getUsagePreset } from "./presets.shared";

/**
 * A config entry either resolves into a complete provider or it does not. An
 * entry naming a missing preset, or one a user has half-filled, keeps its row
 * with `provider: null` and an explanation, so the surface can show why instead
 * of the provider silently vanishing.
 */
export interface UsageProviderEntry {
  id: string;
  provider: UsageProvider | null;
  error: string | null;
}

/**
 * Stamps a user-declared ceiling onto the readings it names. A vendor that
 * publishes no allowance leaves its rows as bare counts; the user knows the
 * number from their plan page, and naming the mapping is how they hand it over
 * without restating the whole reading list.
 */
function applyLimits(
  readings: UsageProvider["readings"],
  limits: Record<string, number>,
): UsageProvider["readings"] {
  if (Object.keys(limits).length === 0) return readings;
  return readings.map((reading) => {
    if (reading.kind !== "quota") return reading;
    const limit = limits[reading.id];
    return limit === undefined ? reading : { ...reading, limit };
  });
}

/**
 * A preset supplies the shape; the override supplies what the user changed.
 * `readings` and `source` replace wholesale, because a half-merged reading list
 * would describe a document neither side meant. `credentials` and `display`
 * merge by key, so storing one credential, or dragging one card, does not drop
 * everything else the preset or the user already had.
 */
function applyOverride(preset: UsageProvider, override: UsageProviderOverride): UsageProvider {
  return {
    ...preset,
    ...(override.label === undefined ? {} : { label: override.label }),
    ...(override.description === undefined ? {} : { description: override.description }),
    ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
    ...(override.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: override.refreshIntervalMs }),
    ...(override.source === undefined ? {} : { source: override.source }),
    ...(override.readings === undefined ? {} : { readings: override.readings }),
    limits: override.limits === undefined ? preset.limits : override.limits,
    ...(override.icon === undefined ? {} : { icon: override.icon }),
    credentials:
      override.credentials === undefined
        ? preset.credentials
        : { ...preset.credentials, ...override.credentials },
    display:
      override.display === undefined ? preset.display : { ...preset.display, ...override.display },
  };
}

function resolveEntry(id: string, override: UsageProviderOverride): UsageProviderEntry {
  if (override.preset !== undefined) {
    const preset = getUsagePreset(override.preset);
    if (!preset) {
      return { id, provider: null, error: `Unknown preset "${override.preset}"` };
    }
    const provider = applyOverride(preset, override);
    return {
      id,
      provider: { ...provider, readings: applyLimits(provider.readings, provider.limits) },
      error: null,
    };
  }

  const parsed = UsageProviderSchema.safeParse(override);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map((part) => String(part)).join(".");
        return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
    return { id, provider: null, error: detail };
  }
  const provider = parsed.data;
  return {
    id,
    provider: { ...provider, readings: applyLimits(provider.readings, provider.limits) },
    error: null,
  };
}

export function buildProviderRegistry(overrides: UsageProviderOverrides): UsageProviderEntry[] {
  return Object.entries(overrides)
    .map(([id, override]) => resolveEntry(id, override))
    .sort((left, right) => left.id.localeCompare(right.id));
}
