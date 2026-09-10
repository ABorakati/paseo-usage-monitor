import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { LimitAlert } from "../shared/limit-alerts.shared";
import { UsageSnapshotSchema, type UsageSnapshot } from "../shared/limits.shared";
import {
  createLimitAlertService,
  type LimitAlertAdapters,
  type LimitAlertService,
  type LimitAlertTurnEvent,
} from "./limit-alerts.server";

const HOME = "/home/tester";
const NOW_MS = Date.parse("2026-09-10T11:00:00.000Z");
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const CODEX_QUOTA_REFUSAL =
  "Codex error event: The usage limit has been reached (code=usage_limit_reached)";
const CLAUDE_QUOTA_REFUSAL = "You've hit your limit · resets 3pm (Europe/London)";

let nowMs = NOW_MS;

type TimelineItem = LimitAlertTurnEvent["timeline"][number];

interface HarnessState {
  files: Map<string, string>;
  ids: number;
}

function harnessState(): HarnessState {
  return { files: new Map(), ids: 0 };
}

interface FakePaseo {
  paseo: PaseoApi;
  send: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  create: ReturnType<typeof vi.fn<(options: Record<string, unknown>) => Promise<{ id: string }>>>;
  /** The model each agent id reports, for the cases that read one. */
  models: Map<string, string>;
}

function createFakePaseo(): FakePaseo {
  const send = vi.fn<(text: string) => Promise<void>>();
  send.mockResolvedValue(undefined);
  const create = vi.fn<(options: Record<string, unknown>) => Promise<{ id: string }>>();
  create.mockResolvedValue({ id: "new-agent" });
  const models = new Map<string, string>();
  const paseo = {
    agents: {
      // `ref()` carries no snapshot until it is refreshed, exactly as the real
      // handle behaves.
      ref: (id: string) => ({
        send,
        refresh: () => Promise.resolve(),
        current: () => {
          const model = models.get(id);
          return model === undefined ? null : { model };
        },
      }),
      create,
    },
  } as unknown as PaseoApi;
  return { paseo, send, create, models };
}

interface Harness {
  service: LimitAlertService;
  adapters: LimitAlertAdapters;
  paseo: PaseoApi;
  send: FakePaseo["send"];
  create: FakePaseo["create"];
  models: FakePaseo["models"];
  state: HarnessState;
}

function createHarness(state: HarnessState = harnessState()): Harness {
  const adapters: LimitAlertAdapters = {
    env: {},
    homeDir: HOME,
    readConfigFile: () => ({ kind: "missing" }),
    readFile: (target) => state.files.get(target) ?? null,
    writeFile: (target, text) => {
      state.files.set(target, text);
    },
    now: () => new Date(nowMs),
    randomId: () => `alert-${++state.ids}`,
    readLimits: () => Promise.resolve(emptySnapshot()),
  };
  const { paseo, send, create, models } = createFakePaseo();
  return {
    service: createLimitAlertService(adapters),
    adapters,
    paseo,
    send,
    create,
    models,
    state,
  };
}

function emptySnapshot(): UsageSnapshot {
  return { configPath: `${HOME}/.paseo/usage-limits.json`, providers: [] };
}

function snapshotWithReset(providerId: string, resetsAt: string): UsageSnapshot {
  return UsageSnapshotSchema.parse({
    configPath: `${HOME}/.paseo/usage-limits.json`,
    providers: [
      {
        providerId,
        label: providerId,
        description: null,
        unverified: false,
        live: false,
        status: "ok",
        readings: [
          {
            id: "weekly",
            label: "Weekly",
            group: null,
            kind: "quota",
            unit: "percent",
            window: { label: "Weekly", resetsAt, durationMs: null },
            used: 100,
            limit: 100,
            remaining: 0,
            percent: 100,
          },
        ],
        error: null,
        fetchedAt: null,
        notice: null,
        authRefreshCommand: null,
        display: {},
        icon: null,
      },
    ],
  });
}

interface EventOptions {
  agentId?: string;
  provider?: string;
  cwd?: string;
  title?: string | null;
  lastUserMessage?: string;
}

function agentFor(options: EventOptions): LimitAlertTurnEvent["agent"] {
  return {
    id: options.agentId ?? "agent-1",
    workspaceId: "ws-1",
    parentAgentId: null,
    provider: options.provider ?? "claude",
    cwd: options.cwd ?? "/work",
    title: options.title === undefined ? "Fix login" : options.title,
  };
}

function timelineFor(options: EventOptions): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  if (options.lastUserMessage !== undefined) {
    timeline.push({ type: "user_message", text: options.lastUserMessage });
  }
  return timeline;
}

function failedEvent(message: string, options: EventOptions = {}): LimitAlertTurnEvent {
  return {
    agent: agentFor(options),
    turnId: "turn-1",
    outcome: { kind: "failed", error: { message } },
    timeline: timelineFor(options),
  };
}

function completedEvent(assistantText: string, options: EventOptions = {}): LimitAlertTurnEvent {
  return {
    agent: agentFor(options),
    turnId: "turn-1",
    outcome: { kind: "completed" },
    timeline: [...timelineFor(options), { type: "assistant_message", text: assistantText }],
  };
}

function onlyAlert(service: LimitAlertService): LimitAlert {
  const alerts = service.list();
  expect(alerts).toHaveLength(1);
  const alert = alerts[0];
  if (alert === undefined) throw new Error("expected a single alert");
  return alert;
}

describe("limit alert service", () => {
  beforeEach(() => {
    nowMs = NOW_MS;
    vi.useFakeTimers();
  });

  test("records an alert from a failed turn, borrowing the reset from the quota card", async () => {
    const harness = createHarness();
    harness.adapters.readLimits = () =>
      Promise.resolve(snapshotWithReset("codex", "2026-09-10T18:00:00.000Z"));

    const alert = await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, {
        provider: "codex",
        lastUserMessage: "publish the release",
      }),
      harness.paseo,
    );

    expect(alert).toMatchObject({
      agentId: "agent-1",
      agentProvider: "codex",
      providerLabel: "Codex",
      usageProviderId: "codex",
      status: "open",
      limitKind: "quota",
      topUpUrl: null,
      resetsAt: "2026-09-10T18:00:00.000Z",
      resetUrl: "https://chatgpt.com/codex/settings/usage",
      lastUserMessage: "publish the release",
      cwd: "/work",
      title: "Fix login",
    });
    expect(alert?.message).toContain("usage_limit_reached");
  });

  test("records a spent balance with a top-up link and no reset time", async () => {
    const harness = createHarness();
    harness.models.set("agent-1", "deepseek/deepseek-flash");
    // The vendor also has a card the plugin can read. A window borrowed from it
    // would be a reset the balance does not have.
    harness.adapters.readLimits = () =>
      Promise.resolve(snapshotWithReset("deepseek", "2026-09-12T00:00:00.000Z"));

    const alert = await harness.service.record(
      failedEvent("DeepSeek API error 402: Insufficient Balance", {
        provider: "omp",
        lastUserMessage: "summarise the incident logs",
      }),
      harness.paseo,
    );

    expect(alert).toMatchObject({
      agentId: "agent-1",
      agentProvider: "omp",
      providerLabel: "DeepSeek",
      usageProviderId: "deepseek",
      limitKind: "balance",
      topUpUrl: "https://platform.deepseek.com/top_up",
      resetUrl: "https://platform.deepseek.com/usage",
      resetsAt: null,
      lastUserMessage: "summarise the incident logs",
      status: "open",
    });
    expect(alert?.message).toContain("Insufficient Balance");
  });

  test("records an alert from Claude's assistant message on a completed turn", async () => {
    const harness = createHarness();

    const alert = await harness.service.record(
      completedEvent(CLAUDE_QUOTA_REFUSAL, { lastUserMessage: "write the migration" }),
      harness.paseo,
    );

    expect(alert).toMatchObject({
      agentProvider: "claude",
      providerLabel: "Claude",
      status: "open",
      resetsAt: "2026-09-10T14:00:00.000Z",
      lastUserMessage: "write the migration",
    });
  });

  test("records nothing for a failure that is not a usage limit", async () => {
    const harness = createHarness();

    const alert = await harness.service.record(
      failedEvent("TypeError: Cannot read properties of undefined", {
        lastUserMessage: "run the build",
      }),
      harness.paseo,
    );

    expect(alert).toBeNull();
    expect(harness.service.list()).toEqual([]);
  });

  test("replaces the agent's still-open alert instead of stacking a second", async () => {
    const harness = createHarness();

    const first = await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );
    const second = await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );

    const alerts = harness.service.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe(second?.id);
    expect(alerts[0]?.id).not.toBe(first?.id);
  });

  test("sends the resume prompt when the timer fires and marks the alert resumed", async () => {
    const harness = createHarness();
    await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex", lastUserMessage: "add the retry" }),
      harness.paseo,
    );
    const alert = onlyAlert(harness.service);

    harness.service.scheduleResume(alert.id, "2026-09-10T11:05:00.000Z");
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

    expect(harness.send).toHaveBeenCalledWith(
      "The usage limit has reset. Continue where you left off.\n\nMy last request was:\nadd the retry",
    );
    expect(onlyAlert(harness.service).status).toBe("resumed");
  });

  test("cancelling a resume clears the timer and reopens the alert", async () => {
    const harness = createHarness();
    await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );
    const alert = onlyAlert(harness.service);

    const scheduled = harness.service.scheduleResume(alert.id, "2026-09-10T11:05:00.000Z");
    expect(scheduled.status).toBe("resume_scheduled");

    const cancelled = harness.service.cancelResume(alert.id);
    expect(cancelled.status).toBe("open");
    expect(cancelled.resume).toBeNull();

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS * 2);
    expect(harness.send).not.toHaveBeenCalled();
  });

  test("refuses to schedule a resume when no reset time is known", async () => {
    const harness = createHarness();
    await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );
    const alert = onlyAlert(harness.service);

    expect(() => harness.service.scheduleResume(alert.id)).toThrow(
      "No reset time known for this alert",
    );
  });

  test("hands the work off to a new agent on the chosen provider", async () => {
    const harness = createHarness();
    await harness.service.record(
      completedEvent(CLAUDE_QUOTA_REFUSAL, { lastUserMessage: "make login work" }),
      harness.paseo,
    );
    const alert = onlyAlert(harness.service);

    const handed = await harness.service.handOff(
      alert.id,
      "openai-codex/gpt-5.6",
      undefined,
      harness.paseo,
    );

    expect(harness.create).toHaveBeenCalledTimes(1);
    const options = harness.create.mock.calls[0]?.[0] ?? {};
    expect(options.config).toEqual({ provider: "openai-codex/gpt-5.6" });
    expect(options.cwd).toBe("/work");
    expect(options.title).toBe("Fix login (handoff)");
    expect(options.prompt).toContain(
      "You are taking over from an agent on Claude that hit its usage limit.",
    );
    expect(options.prompt).toContain("make login work");

    expect(handed.status).toBe("handed_off");
    expect(handed.handoff).toEqual({
      agentId: "new-agent",
      provider: "openai-codex/gpt-5.6",
      createdAt: "2026-09-10T11:00:00.000Z",
    });
  });

  test("arms a resume on its own when the setting is on", async () => {
    const harness = createHarness();
    harness.service.writeSettings({ autoResume: true });

    await harness.service.record(
      failedEvent(`${CODEX_QUOTA_REFUSAL} Resets in 5 minutes`, { provider: "codex" }),
      harness.paseo,
    );

    const alert = onlyAlert(harness.service);
    expect(alert.status).toBe("resume_scheduled");
    expect(alert.resume?.automatic).toBe(true);

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(onlyAlert(harness.service).status).toBe("resumed");
  });

  test("re-arms a scheduled resume when the service restarts", async () => {
    const harness = createHarness();
    harness.service.writeSettings({ autoResume: true });
    await harness.service.record(
      failedEvent(`${CODEX_QUOTA_REFUSAL} Resets in 5 minutes`, { provider: "codex" }),
      harness.paseo,
    );
    expect(onlyAlert(harness.service).status).toBe("resume_scheduled");
    harness.service.close();

    const restarted = createHarness(harness.state);
    expect(restarted.service.readSettings().autoResume).toBe(true);
    restarted.service.start(restarted.paseo);

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(restarted.send).toHaveBeenCalledTimes(1);
    expect(onlyAlert(restarted.service).status).toBe("resumed");
  });

  test("dismissing an alert closes it without sending anything", async () => {
    const harness = createHarness();
    await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );
    const alert = onlyAlert(harness.service);

    const dismissed = harness.service.dismiss(alert.id);
    expect(dismissed.status).toBe("dismissed");
    expect(onlyAlert(harness.service).status).toBe("dismissed");
  });

  test("records nothing at all while alerts are disabled", async () => {
    const harness = createHarness();
    harness.service.writeSettings({ enabled: false });

    const alert = await harness.service.record(
      failedEvent(CODEX_QUOTA_REFUSAL, { provider: "codex" }),
      harness.paseo,
    );

    expect(alert).toBeNull();
    expect(harness.service.list()).toEqual([]);
  });
});
