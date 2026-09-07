import { describe, expect, test, vi } from "vitest";
import { contributeComposerPills } from "./pills.client";
import { createMockClientContext } from "./test-stubs/plugin-client";
import type { UsagePillDisplay, UsageProviderSnapshot } from "./limits.shared";

function pill(overrides: Partial<UsagePillDisplay> = {}): UsagePillDisplay {
  return {
    enabled: true,
    visibility: "always",
    label: "provider",
    readout: "percent",
    ...overrides,
  };
}

function mockSnapshot(providers: Partial<UsageProviderSnapshot>[]): unknown[] {
  return providers.map((p) => ({
    providerId: "test-provider",
    label: "Test Provider",
    status: "ok",
    unverified: false,
    readings: [],
    error: null,
    notice: null,
    fetchedAt: null,
    display: { pill: pill() },
    icon: null,
    ...p,
  }));
}

describe("contributeComposerPills client lifecycle", () => {
  test("seeds pills from existing agent directory on startup", async () => {
    const providers = mockSnapshot([
      {
        providerId: "openai-pill",
        label: "OpenAI Usage",
        display: {
          pill: pill({
            enabled: true,
            visibility: "matching",
            matchRules: [{ harness: "omp", provider: "openai" }],
          }),
        },
      },
      {
        providerId: "always-pill",
        label: "Always Usage",
        display: {
          pill: pill({ enabled: true, visibility: "always" }),
        },
      },
    ]);

    const client = createMockClientContext(providers);

    // Pre-populate an existing matching agent and an existing non-matching agent
    client.simulateAgentAdded({
      id: "agent-matching",
      workspaceId: "wks-1",
      provider: "omp",
      model: "openai/gpt-5",
    });
    client.simulateAgentAdded({
      id: "agent-other",
      workspaceId: "wks-2",
      provider: "omp",
      model: "anthropic/claude-3-5-sonnet",
    });

    const stop = contributeComposerPills(client);

    // Allow async refresh() (which calls agents.list() and rpc()) to resolve
    await vi.waitFor(() => {
      expect(client.registeredPills.length).toBe(3);
    });

    const matchingPills = client.registeredPills.filter((p) => p.agentId === "agent-matching");
    const otherPills = client.registeredPills.filter((p) => p.agentId === "agent-other");

    expect(matchingPills.map((p) => p.id).sort()).toEqual([
      "usage-always-pill",
      "usage-openai-pill",
    ]);
    expect(matchingPills[0]?.workspaceId).toBe("wks-1");

    expect(otherPills.map((p) => p.id)).toEqual(["usage-always-pill"]);
    expect(otherPills[0]?.workspaceId).toBe("wks-2");

    stop();
    expect(client.registeredPills.length).toBe(0);
  });

  test("live agent subscription adds and removes matching pills when model changes", async () => {
    const providers = mockSnapshot([
      {
        providerId: "openai-pill",
        label: "OpenAI Usage",
        display: {
          pill: pill({
            enabled: true,
            visibility: "matching",
            matchRules: [{ harness: "omp", provider: "openai" }],
          }),
        },
      },
    ]);

    const client = createMockClientContext(providers);
    const stop = contributeComposerPills(client);

    // 1. Add agent with matching model
    client.simulateAgentAdded({
      id: "agent-live",
      workspaceId: "wks-1",
      provider: "omp",
      model: "openai/gpt-4o",
    });

    await vi.waitFor(() => {
      expect(client.registeredPills.map((p) => p.id)).toEqual(["usage-openai-pill"]);
    });

    // 2. Switch agent model to non-matching vendor
    client.simulateAgentAdded({
      id: "agent-live",
      workspaceId: "wks-1",
      provider: "omp",
      model: "google/gemini-2.5",
    });

    await vi.waitFor(() => {
      expect(client.registeredPills.length).toBe(0);
    });

    // 3. Switch back to matching model
    client.simulateAgentAdded({
      id: "agent-live",
      workspaceId: "wks-1",
      provider: "omp",
      model: "openai/gpt-5-mini",
    });

    await vi.waitFor(() => {
      expect(client.registeredPills.map((p) => p.id)).toEqual(["usage-openai-pill"]);
    });

    // 4. Remove agent entirely
    client.simulateAgentRemoved("agent-live");
    await vi.waitFor(() => {
      expect(client.registeredPills.length).toBe(0);
    });

    stop();
  });

  test("does not register pills for disabled providers", async () => {
    const providers = mockSnapshot([
      {
        providerId: "disabled-provider",
        label: "Disabled Usage",
        status: "disabled",
        display: {
          pill: pill({ enabled: true, visibility: "always" }),
        },
      },
    ]);

    const client = createMockClientContext(providers);
    client.simulateAgentAdded({
      id: "agent-1",
      workspaceId: "wks-1",
      provider: "omp",
      model: "openai/gpt-5",
    });

    const stop = contributeComposerPills(client);

    await vi.waitFor(() => {
      expect(client.registeredPills.length).toBe(0);
    });

    stop();
  });
});
