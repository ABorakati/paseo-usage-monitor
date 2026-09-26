import type React from "react";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type {
  PaseoAgent,
  PaseoAgentUpdate,
  PaseoAgentListOptions,
  PaseoAgentListResult,
} from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

/**
 * What the host's `addComposerPill` accepts, taken from the contract itself so
 * this stub cannot drift from the SDK's contribution shape.
 */
type RegisteredPill = Parameters<PluginClientContext["addComposerPill"]>[0];

export function Icon(): React.ReactElement | null {
  return null;
}

/** The host's modal and text field, present so a client module's imports resolve. */
export function Modal(): React.ReactElement | null {
  return null;
}

export function TextInput(): React.ReactElement | null {
  return null;
}

export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  _contract: PluginRpcContract<InputSchema, OutputSchema>,
): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>> {
  return async () => ({}) as unknown as ZodOutput<OutputSchema>;
}

export function useToast() {
  return {
    show: () => {},
    error: () => {},
  };
}

export function defineRpc<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineAttachmentSource<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineSettings<Definition>(definition: Definition): Definition {
  return definition;
}

export interface MockClientContext extends PluginClientContext {
  registeredPills: RegisteredPill[];
  simulateAgentAdded: (agent: Partial<PaseoAgent> & { id: string; workspaceId: string }) => void;
  simulateAgentRemoved: (agentId: string) => void;
  /** Drops an agent from the directory without delivering an update. */
  simulateAgentLost: (agentId: string) => void;
  simulateLimitsUpdate: (providers: unknown[]) => void;
  /** Redelivers a full directory snapshot; false while no observer is subscribed. */
  simulateObservationSnapshot: () => boolean;
}

export function createMockClientContext(
  initialProviders: unknown[] = [],
  legacy = false,
): MockClientContext {
  const registeredPills: RegisteredPill[] = [];
  const agentSubscribers = new Set<(update: PaseoAgentUpdate) => void>();
  const agents = new Map<string, PaseoAgent>();
  let currentProviders = initialProviders;
  let observingAgents = false;
  let observationUpdate: ((message: SessionOutboundMessage) => void) | undefined;
  let observationSnapshot: ((directory: PaseoAgentListResult) => void) | undefined;

  const buildSnapshot = (): PaseoAgentListResult => ({
    requestId: "mock-list-req",
    subscriptionId: null,
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    entries: Array.from(agents.values()).map((agent) => ({
      agent,
      project: {} as unknown as PaseoAgentListResult["entries"][number]["project"],
    })),
  });

  const mock: MockClientContext = {
    registeredPills,

    addComposerPill(contribution: RegisteredPill): PluginButtonRegistration {
      registeredPills.push(contribution);
      return {
        update(patch) {
          Object.assign(contribution.button, patch);
        },
        remove() {
          const index = registeredPills.indexOf(contribution);
          if (index >= 0) {
            registeredPills.splice(index, 1);
          }
        },
      };
    },

    // Nothing in these tests draws a header button, so it holds no state.
    addHeaderButton: () => ({ update: () => {}, remove: () => {} }),

    addSettingsScreen: () => () => {},
    addSurface: () => () => {},
    addSidebarItem: () => () => {},
    addWorkspacePanel: () => () => {},
    addCommandCenterItem: () => () => {},
    addSlashCommand: () => () => {},
    addAttachmentSource: () => () => {},
    addTheme: () => () => {},
    addTimelineTransformer: () => () => {},
    addTimelineRenderer: () => () => {},

    openPanel: () => {},
    openSurface: () => {},
    openSettings: () => {},

    rpc: async <InputSchema extends ZodType = ZodType, OutputSchema extends ZodType = ZodType>(
      _contract: PluginRpcContract<InputSchema, OutputSchema>,
      _input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>> =>
      ({ providers: currentProviders }) as unknown as ZodOutput<OutputSchema>,

    paseo: {
      dispose: async () => {},
      ...(!legacy && {
        observeEvents: (() => {}) as unknown as PluginClientContext["paseo"]["observeEvents"],
      }),
      workspaces: {} as unknown as PluginClientContext["paseo"]["workspaces"],
      terminals: {} as unknown as PluginClientContext["paseo"]["terminals"],
      projects: {} as unknown as PluginClientContext["paseo"]["projects"],
      providers: {} as unknown as PluginClientContext["paseo"]["providers"],
      config: {} as unknown as PluginClientContext["paseo"]["config"],
      agents: {
        list: async (options?: PaseoAgentListOptions): Promise<PaseoAgentListResult> => {
          const snapshot: PaseoAgentListResult = buildSnapshot();
          if (options?.subscribe) {
            observingAgents = true;
            return {
              ...snapshot,
              subscription: {
                subscribe: (observer: {
                  snapshot(value: PaseoAgentListResult): void;
                  update(message: SessionOutboundMessage): void;
                }) => {
                  observer.snapshot(snapshot);
                  observationUpdate = observer.update;
                  observationSnapshot = observer.snapshot;
                  return () => {
                    observationUpdate = undefined;
                    observationSnapshot = undefined;
                  };
                },
                release: async () => {
                  observingAgents = false;
                  observationUpdate = undefined;
                  observationSnapshot = undefined;
                },
              },
            } as PaseoAgentListResult;
          }
          return snapshot;
        },
        subscribe: (listener: (update: PaseoAgentUpdate) => void): (() => void) => {
          agentSubscribers.add(listener);
          return () => {
            agentSubscribers.delete(listener);
          };
        },
      } as unknown as PluginClientContext["paseo"]["agents"],
    } as PluginClientContext["paseo"],

    simulateAgentAdded(agentData) {
      const agent: PaseoAgent = {
        id: agentData.id,
        workspaceId: agentData.workspaceId,
        provider: agentData.provider ?? "codex",
        status: agentData.status ?? "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUserMessageAt: new Date().toISOString(),
        title: agentData.title ?? null,
        cwd: agentData.cwd ?? "/test",
        model: agentData.model ?? null,
        currentModeId: agentData.currentModeId ?? null,
        thinkingOptionId: agentData.thinkingOptionId ?? null,
        requiresAttention: false,
        attentionReason: null,
      } as unknown as PaseoAgent;
      agents.set(agent.id, agent);
      const update: PaseoAgentUpdate = { kind: "upsert", agent };
      if (observingAgents) {
        observationUpdate?.({ type: "agent_update", payload: update } as SessionOutboundMessage);
      } else if (!("observeEvents" in mock.paseo)) {
        for (const subscriber of agentSubscribers) subscriber(update);
      }
    },

    simulateAgentRemoved(agentId: string) {
      agents.delete(agentId);
      const update: PaseoAgentUpdate = { kind: "remove", agentId };
      if (observingAgents) {
        observationUpdate?.({ type: "agent_update", payload: update } as SessionOutboundMessage);
      } else if (!("observeEvents" in mock.paseo)) {
        for (const subscriber of agentSubscribers) subscriber(update);
      }
    },

    /**
     * Drops an agent from the directory with no update, the way a removal made
     * while the subscription is down stays invisible until the next snapshot.
     */
    simulateAgentLost(agentId: string) {
      agents.delete(agentId);
    },

    simulateLimitsUpdate(providers: unknown[]) {
      currentProviders = providers;
    },

    /**
     * Redelivers a full directory snapshot to the observation's observer.
     * Reports false while no observer is subscribed yet.
     */
    simulateObservationSnapshot(): boolean {
      if (!observationSnapshot) return false;
      observationSnapshot(buildSnapshot());
      return true;
    },
  };

  return mock;
}
