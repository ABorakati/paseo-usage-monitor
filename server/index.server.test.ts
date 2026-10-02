import { describe, expect, test, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { USAGE_PRESETS } from "../shared/presets.shared";
import contributeServer from "../index.server";

function mockServer(usageSource?: (source: { id: string }) => void) {
  const handledNames: string[] = [];
  const eventHandlers: string[] = [];
  const server = {
    handle: vi.fn((contract) => handledNames.push(contract.name)),
    on: vi.fn((event) => {
      eventHandlers.push(event);
      return () => {};
    }),
    before: vi.fn(() => () => {}),
    registerSettings: vi.fn(),
    registerProvider: vi.fn(),
    ...(usageSource === undefined ? {} : { registerUsageSource: vi.fn(usageSource) }),
  } as unknown as PluginServerContext;
  return { server, handledNames, eventHandlers };
}

describe("index.server v0.8 entry point", () => {
  test("loads on hosts without native usage support", () => {
    const { server, handledNames, eventHandlers } = mockServer();
    const cleanup = contributeServer(server);
    expect(typeof cleanup).toBe("function");
    expect(handledNames).toEqual([
      "usage.limits.read",
      "usage.history.read",
      "usage.config.read",
      "usage.config.write-provider",
      "usage.config.remove-provider",
      "usage.config.test-provider",
      "usage.codex.banked-reset.read",
      "usage.codex.banked-reset.consume",
      "usage.claude-statusline.read",
      "usage.claude-statusline.install",
      "usage.claude-statusline.uninstall",
      "usage.limit-alerts.read",
      "usage.limit-alerts.dismiss",
      "usage.limit-alerts.settings.read",
      "usage.limit-alerts.settings.write",
      "usage.limit-alerts.resume.schedule",
      "usage.limit-alerts.resume.cancel",
      "usage.limit-alerts.handoff",
    ]);
    expect(eventHandlers).toEqual(["agent.turn_ended"]);
    cleanup();
  });

  test("registers one source for the general providers and every preset", () => {
    const sourceIds: string[] = [];
    const { server } = mockServer((source) => sourceIds.push(source.id));
    const cleanup = contributeServer(server);
    expect(sourceIds).toEqual([
      "usage-monitor",
      ...Object.keys(USAGE_PRESETS).map((presetId) => `usage-monitor.${presetId}`),
    ]);
    expect(sourceIds.every((id) => /^[a-z][a-z0-9._-]*$/.test(id))).toBe(true);
    cleanup();
  });
});
