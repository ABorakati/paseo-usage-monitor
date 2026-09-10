import { describe, expect, test, vi } from "vitest";
import {
  contributeComposerPills,
  TERMINAL_REFRESH_IDLE,
  terminalRefreshReducer,
} from "./pills.client";
import { LIMITS_POLL_MS } from "./limits.client";
import { createMockClientContext } from "../test-stubs/plugin-client";
import type {
  UsagePillDisplay,
  UsageProviderSnapshot,
  UsageQuotaReading,
} from "../shared/limits.shared";

function pill(overrides: Partial<UsagePillDisplay> = {}): UsagePillDisplay {
  return {
    enabled: true,
    visibility: "always",
    label: "provider",
    readout: "percent",
    ...overrides,
  };
}

/** A quota reading whose consumption is the whole story. */
function quota(used: number): UsageQuotaReading {
  return {
    kind: "quota",
    id: "session",
    label: "Session",
    group: null,
    unit: "tokens",
    window: { label: "Session", resetsAt: null, durationMs: 18_000_000 },
    used,
    limit: 100,
    remaining: 100 - used,
    percent: null,
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
    authRefreshCommand: null,
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

    // The host draws the button itself, so what travels with the registration
    // is the descriptor and the popover it opens.
    expect(matchingPills[0]?.button.title).toBe("Always Usage usage");
    expect(matchingPills[0]?.button.label).toBe("Always Usage · —");
    expect(matchingPills[0]?.button.behavior.kind).toBe("popover");
    expect(matchingPills[1]?.button.title).toBe("OpenAI Usage usage");

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
    expect(client.registeredPills[0]?.button.title).toBe("OpenAI Usage usage");

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

describe("composer pill text", () => {
  test("a poll that changes the reading updates the label in place", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockClientContext(mockSnapshot([{ readings: [quota(10)] }]));
      client.simulateAgentAdded({ id: "agent-1", workspaceId: "wks-1", provider: "omp" });
      const stop = contributeComposerPills(client);

      await vi.waitFor(() => {
        expect(client.registeredPills.length).toBe(1);
      });
      const registered = client.registeredPills[0];
      expect(registered?.button.label).toBe("Test Provider · 10%");

      client.simulateLimitsUpdate(mockSnapshot([{ readings: [quota(40)] }]));
      await vi.advanceTimersByTimeAsync(LIMITS_POLL_MS);
      await vi.waitFor(() => {
        expect(client.registeredPills[0]?.button.label).toBe("Test Provider · 40%");
      });

      // Same contribution, same registration: the host updates the button in
      // place rather than being handed a new one.
      expect(client.registeredPills.length).toBe(1);
      expect(client.registeredPills[0]).toBe(registered);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminal refresh state machine", () => {
  test("start always resets to running with no lines, from idle or done", () => {
    expect(terminalRefreshReducer(TERMINAL_REFRESH_IDLE, { type: "start" })).toEqual({
      status: "running",
      lines: [],
    });
    const done = { status: "done" as const, lines: ["stale output"] };
    expect(terminalRefreshReducer(done, { type: "start" })).toEqual({
      status: "running",
      lines: [],
    });
  });

  test("output while running replaces lines, capped to the last six", () => {
    const running = { status: "running" as const, lines: [] };
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const next = terminalRefreshReducer(running, { type: "output", lines: many });
    expect(next.status).toBe("running");
    expect(next.lines).toEqual(many.slice(-6));
  });

  test("output is a no-op once the run has already ended", () => {
    const idle = TERMINAL_REFRESH_IDLE;
    expect(terminalRefreshReducer(idle, { type: "output", lines: ["late"] })).toBe(idle);
    const done = { status: "done" as const, lines: ["final"] };
    expect(terminalRefreshReducer(done, { type: "output", lines: ["late"] })).toBe(done);
  });

  test("finish moves a running refresh to done, keeping its last lines", () => {
    const running = { status: "running" as const, lines: ["started claude"] };
    expect(terminalRefreshReducer(running, { type: "finish" })).toEqual({
      status: "done",
      lines: ["started claude"],
    });
  });

  test("finish is a no-op when nothing is running", () => {
    expect(terminalRefreshReducer(TERMINAL_REFRESH_IDLE, { type: "finish" })).toBe(
      TERMINAL_REFRESH_IDLE,
    );
  });

  test("failed always lands on done with the one explanatory line, from any state", () => {
    const running = { status: "running" as const, lines: ["partial output"] };
    expect(
      terminalRefreshReducer(running, { type: "failed", message: "Could not start `claude`" }),
    ).toEqual({ status: "done", lines: ["Could not start `claude`"] });
  });
});
