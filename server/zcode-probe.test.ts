import { describe, expect, test, vi } from "vitest";
import { getUsagePreset } from "../shared/presets.shared";
import { projectReadings } from "./readings.server";
import { createNodeCredentialAdapters } from "./credentials.server";
import { createNodeSourceAdapters, fetchSourceDocument } from "./source.server";
import { probeZCodeUsage, type ZCodeUsageProviders } from "./zcode-probe.server";

type UsageResult = Awaited<ReturnType<ZCodeUsageProviders["listUsage"]>>;
type UsageReport = UsageResult["providers"][number];

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    providerId: "zcode",
    displayName: "ZCode",
    status: "available",
    planLabel: "Coding Plan",
    windows: [],
    ...overrides,
  };
}

function mockProviders(providers: UsageReport[]) {
  return {
    listUsage: vi.fn<ZCodeUsageProviders["listUsage"]>().mockResolvedValue({
      requestId: "test-request",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      providers,
    }),
  };
}

describe("the ZCode probe", () => {
  test("projects all windows from the native ZCode report, including zero usage and new windows", async () => {
    const reset = "2026-01-01T05:00:00.000Z";
    const api = mockProviders([
      report({
        providerId: "zai",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 90 }],
      }),
      report({
        windows: [
          { id: "first-five", label: "5-hour", usedPct: 0, resetsAt: reset },
          { id: "new_vendor_window", label: "Tools", remainingPct: 45 },
        ],
      }),
    ]);
    const preset = getUsagePreset("zcode");
    expect(preset?.source).toEqual({ kind: "probe", probe: "zcode" });
    expect(preset?.credentials).toEqual({});
    const document = await fetchSourceDocument(
      { kind: "probe", probe: "zcode" },
      createNodeSourceAdapters(api),
      createNodeCredentialAdapters(),
    );
    const readings = projectReadings({
      document,
      readings: preset?.readings ?? [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(readings).toMatchObject([
      { id: "window-first-five", percent: 0, window: { resetsAt: reset } },
      { id: "window-new-vendor-window", percent: 55 },
    ]);
    expect(api.listUsage).toHaveBeenCalledOnce();
  });

  test("keeps windows from different ZCode accounts", async () => {
    const result = await probeZCodeUsage(
      mockProviders([
        report({ displayName: "Personal", windows: [{ id: "week", label: "Weekly", usedPct: 1 }] }),
        report({ displayName: "Work", windows: [{ id: "week", label: "Weekly", usedPct: 2 }] }),
      ]),
    );
    expect(result.windows).toMatchObject([
      { id: "1-week", group: "Personal", usedPct: 1 },
      { id: "2-week", group: "Work", usedPct: 2 },
    ]);
  });

  test("reports a missing native source separately from a report without quota", async () => {
    await expect(probeZCodeUsage(mockProviders([report({ providerId: "glm" })]))).rejects.toThrow(
      "Paseo has no ZCode Usage report",
    );
    await expect(
      probeZCodeUsage(mockProviders([report({ status: "unavailable" })])),
    ).rejects.toThrow("Paseo has no available ZCode quota windows");
  });

  test("reports a host error without repeating its raw detail", async () => {
    const api = mockProviders([]);
    api.listUsage.mockRejectedValue(new Error("raw native error"));
    await expect(probeZCodeUsage(api)).rejects.toThrow("Could not read Paseo's Usage reports");
  });
});
