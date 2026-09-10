import type React from "react";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentUpdate, PaseoAgentListResult } from "@getpaseo/client";
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
  simulateLimitsUpdate: (providers: unknown[]) => void;
}

export function createMockClientContext(initialProviders: unknown[] = []): MockClientContext {
  const registeredPills: RegisteredPill[] = [];
  const agentSubscribers = new Set<(update: PaseoAgentUpdate) => void>();
  const agents = new Map<string, PaseoAgent>();
  let currentProviders = initialProviders;

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
      workspaces: {} as unknown as PluginClientContext["paseo"]["workspaces"],
      terminals: {} as unknown as PluginClientContext["paseo"]["terminals"],
      projects: {} as unknown as PluginClientContext["paseo"]["projects"],
      providers: {} as unknown as PluginClientContext["paseo"]["providers"],
      config: {} as unknown as PluginClientContext["paseo"]["config"],
      agents: {
        list: async (): Promise<PaseoAgentListResult> => ({
          requestId: "mock-list-req",
          subscriptionId: null,
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          entries: Array.from(agents.values()).map((agent) => ({
            agent,
            project: {} as unknown as PaseoAgentListResult["entries"][number]["project"],
          })),
        }),
        subscribe: (listener: (update: PaseoAgentUpdate) => void): (() => void) => {
          agentSubscribers.add(listener);
          return () => {
            agentSubscribers.delete(listener);
          };
        },
      } as unknown as PluginClientContext["paseo"]["agents"],
    },

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
      for (const subscriber of agentSubscribers) {
        subscriber({ kind: "upsert", agent });
      }
    },

    simulateAgentRemoved(agentId: string) {
      agents.delete(agentId);
      for (const subscriber of agentSubscribers) {
        subscriber({ kind: "remove", agentId });
      }
    },

    simulateLimitsUpdate(providers: unknown[]) {
      currentProviders = providers;
    },
  };

  return mock;
}
