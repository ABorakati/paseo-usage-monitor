import type React from "react";
import type {
  PluginClientContext,
  PluginCleanup,
  PluginComposerPillContribution,
  PluginRpcContract,
} from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentUpdate, PaseoAgentListResult } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

export function Icon(): React.ReactElement | null {
  return null;
}

export interface MockClientContext extends PluginClientContext {
  registeredPills: PluginComposerPillContribution[];
  simulateAgentAdded: (agent: Partial<PaseoAgent> & { id: string; workspaceId: string }) => void;
  simulateAgentRemoved: (agentId: string) => void;
  simulateLimitsUpdate: (providers: unknown[]) => void;
}

export function createMockClientContext(initialProviders: unknown[] = []): MockClientContext {
  const registeredPills: PluginComposerPillContribution[] = [];
  const agentSubscribers = new Set<(update: PaseoAgentUpdate) => void>();
  const agents = new Map<string, PaseoAgent>();
  let currentProviders = initialProviders;

  const mock: MockClientContext = {
    registeredPills,

    addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup {
      registeredPills.push(contribution);
      return () => {
        const index = registeredPills.indexOf(contribution);
        if (index >= 0) {
          registeredPills.splice(index, 1);
        }
      };
    },

    openPanel: () => {},

    rpc: async <InputSchema extends ZodType = ZodType, OutputSchema extends ZodType = ZodType>(
      _contract: PluginRpcContract<InputSchema, OutputSchema>,
      _input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>> =>
      ({ providers: currentProviders }) as unknown as ZodOutput<OutputSchema>,

    openSurface: () => {},

    paseo: {
      workspaces: {} as unknown as PluginClientContext["paseo"]["workspaces"],
      projects: {} as unknown as PluginClientContext["paseo"]["projects"],
      providers: {} as unknown as PluginClientContext["paseo"]["providers"],
      config: {} as unknown as PluginClientContext["paseo"]["config"],
      agents: {
        list: async (): Promise<PaseoAgentListResult> => ({
          requestId: "mock-list-req",
          subscriptionId: null,
          entries: Array.from(agents.values()).map((agent) => ({
            agent,
            project: {} as unknown as PaseoAgentListResult["entries"][number]["project"],
          })),
          pageInfo: {
            nextCursor: null,
            prevCursor: null,
            hasMore: false,
          },
        }),
        ref: () => ({}) as unknown as ReturnType<PluginClientContext["paseo"]["agents"]["ref"]>,
        create: async () =>
          ({}) as unknown as ReturnType<PluginClientContext["paseo"]["agents"]["create"]>,
        subscribe: (cb: (update: PaseoAgentUpdate) => void) => {
          agentSubscribers.add(cb);
          return () => {
            agentSubscribers.delete(cb);
          };
        },
      },
    },

    simulateAgentAdded(agentData) {
      const snapshot = {
        provider: "omp",
        cwd: "/workspace",
        model: "openai/gpt-5",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUserMessageAt: null,
        status: "idle",
        title: null,
        currentModeId: null,
        thinkingOptionId: null,
        requiresAttention: false,
        attentionReason: null,
        labels: {},
        ...agentData,
      } as unknown as PaseoAgent;
      agents.set(snapshot.id, snapshot);
      for (const subscriber of agentSubscribers) {
        subscriber({ kind: "upsert", agent: snapshot });
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
