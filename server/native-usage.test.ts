import { beforeEach, describe, expect, test, vi } from "vitest";
import { USAGE_PRESETS } from "../shared/presets.shared";
import { UsageProviderSnapshotSchema } from "../shared/limits.shared";
import type { UsageProviderEntry } from "./registry.server";

const mocks = vi.hoisted(() => ({
  entries: [] as UsageProviderEntry[],
  readEntries: vi.fn(() => mocks.entries),
  readProvider: vi.fn(),
}));

vi.mock("./handlers.server", () => ({
  readNativeUsageEntries: mocks.readEntries,
  readNativeUsageProvider: mocks.readProvider,
}));

import { registerNativeUsageSources } from "./native-usage.server";

function registrations() {
  const sources = new Map<
    string,
    {
      label: string;
      discover(): Promise<{ key: string; label?: string; input: unknown }[]>;
      fetch(input: unknown): Promise<unknown>;
    }
  >();
  registerNativeUsageSources({ registerUsageSource: (source) => sources.set(source.id, source) });
  return sources;
}

beforeEach(() => {
  mocks.entries = [];
  mocks.readEntries.mockClear();
  mocks.readProvider.mockReset();
});

function requirePreset(id: string) {
  const preset = USAGE_PRESETS[id];
  if (preset === undefined) throw new Error(`missing preset ${id}`);
  return preset;
}

describe("native usage sources", () => {
  test("discovers enabled providers according to covered-preset defaults and native overrides", async () => {
    const entries: UsageProviderEntry[] = [
      {
        id: "claude-default",
        preset: "claude",
        provider: { ...requirePreset("claude"), label: "Claude" },
        error: null,
      },
      {
        id: "claude-on",
        preset: "claude",
        provider: { ...requirePreset("claude"), label: "Other Claude", display: { native: true } },
        error: null,
      },
      {
        id: "claude-off",
        preset: "claude",
        provider: { ...requirePreset("claude"), display: { native: false } },
        error: null,
      },
      {
        id: "antigravity-default",
        preset: "antigravity",
        provider: { ...requirePreset("antigravity"), label: "Antigravity" },
        error: null,
      },
      {
        id: "antigravity-off",
        preset: "antigravity",
        provider: { ...requirePreset("antigravity"), display: { native: false } },
        error: null,
      },
      {
        id: "disabled",
        preset: null,
        provider: { ...requirePreset("antigravity"), enabled: false },
        error: null,
      },
      { id: "broken", preset: null, provider: null, error: "invalid configuration" },
      { id: "broken-preset", preset: "claude", provider: null, error: "invalid preset override" },
    ];
    mocks.entries = entries;
    const sources = registrations();
    const claude = await sources.get("usage-monitor.claude")?.discover();
    const antigravity = await sources.get("usage-monitor.antigravity")?.discover();
    const general = await sources.get("usage-monitor")?.discover();
    expect(claude?.map((account) => account.key)).toEqual(["claude-on"]);
    expect(claude?.[0]?.label).toBe("Other Claude");
    expect(antigravity?.map((account) => account.key)).toEqual(["antigravity-default"]);
    expect(general?.map((account) => account.key)).toEqual(["broken"]);
    expect(mocks.readEntries).toHaveBeenCalledTimes(3);
  });

  test("throws when a discovered provider vanishes and returns its snapshot otherwise", async () => {
    const sources = registrations();
    const source = sources.get("usage-monitor");
    mocks.readProvider.mockResolvedValue(null);
    await expect(source?.fetch({ providerId: "vanished" })).rejects.toThrow("no longer exists");
    const parsed = UsageProviderSnapshotSchema.parse({
      providerId: "p",
      label: "Provider",
      description: null,
      unverified: false,
      live: false,
      status: "ok",
      readings: [],
      error: null,
      notice: null,
      authRefreshCommand: null,
      fetchedAt: null,
      display: {},
      icon: null,
    });
    mocks.readProvider.mockResolvedValue(parsed);
    await expect(source?.fetch({ providerId: "p" })).resolves.toEqual({
      status: "available",
      windows: [],
    });
    await expect(source?.fetch({ providerId: "p", unexpected: true })).rejects.toThrow();
  });
});
