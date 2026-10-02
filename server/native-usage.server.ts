import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import { publishesNativeUsage } from "../shared/native-usage.shared";
import { nativeUsageReport } from "./native-usage-report.server";
import { NATIVE_USAGE_FALLBACK_ICON, NATIVE_USAGE_ICONS } from "../shared/native-icons.shared";
import { USAGE_PRESETS } from "../shared/presets.shared";
import { readNativeUsageEntries, readNativeUsageProvider } from "./handlers.server";

const input = z.object({ providerId: z.string() }).strict();

function registration(id: string, label: string, presetId: string | null): UsageSourceRegistration {
  return {
    id,
    label,
    icon:
      presetId === null
        ? NATIVE_USAGE_FALLBACK_ICON
        : (NATIVE_USAGE_ICONS[presetId] ?? NATIVE_USAGE_FALLBACK_ICON),
    input,
    async discover() {
      const accounts = [];
      for (const entry of readNativeUsageEntries()) {
        if (presetId === null ? entry.preset !== null : entry.preset !== presetId) continue;
        const provider = entry.provider;
        if (provider !== null) {
          if (!provider.enabled || !publishesNativeUsage(entry.preset, provider.display)) continue;
          accounts.push({
            key: entry.id,
            ...(presetId === null || provider.label !== label ? { label: provider.label } : {}),
            input: { providerId: entry.id },
          });
        } else if (presetId === null) {
          accounts.push({
            key: entry.id,
            label: entry.id,
            input: { providerId: entry.id },
          });
        }
      }
      return accounts;
    },
    async fetch(value) {
      const { providerId } = input.parse(value);
      const snapshot = await readNativeUsageProvider(providerId);
      if (snapshot === null) throw new Error(`Usage provider "${providerId}" no longer exists`);
      return nativeUsageReport(snapshot);
    },
  };
}

export function registerNativeUsageSources(server: {
  registerUsageSource(source: UsageSourceRegistration): unknown;
}): void {
  server.registerUsageSource(registration("usage-monitor", "Usage Monitor", null));
  for (const presetId of Object.keys(USAGE_PRESETS)) {
    const preset = USAGE_PRESETS[presetId];
    if (preset === undefined) continue;
    server.registerUsageSource(registration(`usage-monitor.${presetId}`, preset.label, presetId));
  }
}
