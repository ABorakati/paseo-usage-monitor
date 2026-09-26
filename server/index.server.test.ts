import { describe, expect, test, vi } from "vitest";
import contributeServer from "../index.server";
import type { PluginServerContext } from "@getpaseo/plugin/server";

describe("index.server v0.8 entry point", () => {
  test("registers all RPC contracts and lifecycle hooks", () => {
    const handledNames: string[] = [];
    const eventHandlers: string[] = [];

    const mockServer = {
      handle: vi.fn((contract) => {
        handledNames.push(contract.name);
      }),
      on: vi.fn((event) => {
        eventHandlers.push(event);
        return () => {};
      }),
      before: vi.fn(() => () => {}),
      registerSettings: vi.fn(),
      registerProvider: vi.fn(),
    } as unknown as PluginServerContext;

    const cleanup = contributeServer(mockServer);
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

    // v0.8 Lifecycle hook
    expect(eventHandlers).toEqual(["agent.turn_ended"]);

    cleanup();
  });
});
