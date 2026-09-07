import { describe, expect, test, vi } from "vitest";
import {
  closeOpenPill,
  computeCardPlacement,
  contributeComposerPills,
  pillInstanceKey,
  readOpenPill,
  toggleOpenPill,
} from "./pills.client";
import { createMockClientContext } from "../test-stubs/plugin-client";
import type { UsagePillDisplay, UsageProviderSnapshot } from "../shared/limits.shared";

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

describe("split-pane pill toggle isolation", () => {
  test("builds unique instance key per agent and provider", () => {
    expect(pillInstanceKey("agent-1", "codex")).toBe("agent-1\0codex");
    expect(pillInstanceKey("agent-2", "codex")).toBe("agent-2\0codex");
    expect(pillInstanceKey(null, "codex")).toBe("codex");
    expect(pillInstanceKey(undefined, "codex")).toBe("codex");
  });

  test("opens only the pressed agent's pill when same provider exists side by side", () => {
    closeOpenPill(false);
    expect(readOpenPill()).toBeNull();

    const agent1Key = pillInstanceKey("agent-1", "codex");
    const agent2Key = pillInstanceKey("agent-2", "codex");

    toggleOpenPill(agent1Key);
    expect(readOpenPill()).toBe(agent1Key);
    expect(readOpenPill() === agent2Key).toBe(false);

    toggleOpenPill(agent2Key);
    expect(readOpenPill()).toBe(agent2Key);
    expect(readOpenPill() === agent1Key).toBe(false);

    closeOpenPill(false);
    expect(readOpenPill()).toBeNull();
  });

  test("registered pill onPress targets its own agent instance key", async () => {
    closeOpenPill(false);
    const providers = mockSnapshot([
      {
        providerId: "codex",
        label: "Codex",
        display: { pill: pill({ enabled: true, visibility: "always" }) },
      },
    ]);
    const client = createMockClientContext(providers);
    client.simulateAgentAdded({ id: "agent-left", workspaceId: "wks-1" });
    client.simulateAgentAdded({ id: "agent-right", workspaceId: "wks-2" });

    const stop = contributeComposerPills(client);
    await vi.waitFor(() => {
      expect(client.registeredPills.length).toBe(2);
    });

    const leftPill = client.registeredPills.find((p) => p.agentId === "agent-left");
    const rightPill = client.registeredPills.find((p) => p.agentId === "agent-right");
    expect(leftPill).toBeDefined();
    expect(rightPill).toBeDefined();

    leftPill?.onPress();
    expect(readOpenPill()).toBe("agent-left\0codex");

    rightPill?.onPress();
    expect(readOpenPill()).toBe("agent-right\0codex");

    closeOpenPill(false);
    expect(readOpenPill()).toBeNull();
    stop();
  });
});

describe("split-pane card placement and containment", () => {
  test("keeps default left: 0 when card fits comfortably within pane", () => {
    const placement = computeCardPlacement({
      pillLeft: 50,
      paneLeft: 0,
      paneRight: 600,
      cardWidth: 232,
      paneMargin: 8,
    });
    expect(placement.left).toBe(0);
    expect(placement.maxWidth).toBe(232);
  });

  test("shifts card left when pill is near the right split boundary", () => {
    // Pane is 0 to 400. Pill is at 300. Card width is 232.
    // Without shift, card right is 300 + 232 = 532 (overflows 400 by 132px).
    const placement = computeCardPlacement({
      pillLeft: 300,
      paneLeft: 0,
      paneRight: 400,
      cardWidth: 232,
      paneMargin: 8,
    });
    // Max allowed right is 400 - 8 = 392.
    // Overflow is 532 - 392 = 140.
    // Left offset relative to pill is -140.
    expect(placement.left).toBe(-140);
    expect(placement.maxWidth).toBe(232);
    // Absolute card right in viewport: pillLeft (300) + left (-140) + width (232) = 392 <= 392
    expect(300 + placement.left + placement.maxWidth).toBe(392);
  });

  test("clamps maxWidth and offset in a narrow pane", () => {
    // Pane is only 200px wide. Margins 8px each side => max available is 184px.
    const placement = computeCardPlacement({
      pillLeft: 20,
      paneLeft: 0,
      paneRight: 200,
      cardWidth: 232,
      paneMargin: 8,
    });
    expect(placement.maxWidth).toBe(184);
    // 20 + 184 = 204. Max allowed right is 200 - 8 = 192. Overflow is 12px.
    expect(placement.left).toBe(-12);
    expect(20 + placement.left).toBe(8); // Aligns with left margin
  });
});
