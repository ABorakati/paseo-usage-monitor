import { describe, expect, test, vi } from "vitest";
import contributeClient from "../index.client";
import type {
  PluginClientContext,
  PluginSettingsScreenContribution,
  PluginClientSlashCommandContribution,
  PluginSidebarContribution,
  PluginWorkspacePanelContribution,
  PluginCommandCenterItemContribution,
} from "@getpaseo/plugin/client";

describe("index.client v0.8 entry point", () => {
  test("registers all surfaces, settings screens, panels, commands, and slash command", () => {
    const surfaces = new Map<string, unknown>();
    const settingsScreens: PluginSettingsScreenContribution[] = [];
    const sidebarItems: PluginSidebarContribution[] = [];
    const workspacePanels: PluginWorkspacePanelContribution[] = [];
    const commandCenterItems: PluginCommandCenterItemContribution[] = [];
    const slashCommands: PluginClientSlashCommandContribution[] = [];

    const mockClient = {
      addSurface: vi.fn((id, component) => {
        surfaces.set(id, component);
        return () => {};
      }),
      addSettingsScreen: vi.fn((contribution) => {
        settingsScreens.push(contribution);
        return () => {};
      }),
      addSidebarItem: vi.fn((contribution) => {
        sidebarItems.push(contribution);
        return () => {};
      }),
      addWorkspacePanel: vi.fn((contribution) => {
        workspacePanels.push(contribution);
        return () => {};
      }),
      addCommandCenterItem: vi.fn((contribution) => {
        commandCenterItems.push(contribution);
        return () => {};
      }),
      addSlashCommand: vi.fn((contribution) => {
        slashCommands.push(contribution);
        return () => {};
      }),
      addComposerPill: vi.fn(() => () => {}),
      addAttachmentSource: vi.fn(() => () => {}),
      addTheme: vi.fn(() => () => {}),
      addTimelineTransformer: vi.fn(() => () => {}),
      addTimelineRenderer: vi.fn(() => () => {}),
      openPanel: vi.fn(),
      openSurface: vi.fn(),
      openSettings: vi.fn(),
      rpc: vi.fn(),
      paseo: {
        workspaces: {} as never,
        projects: {} as never,
        providers: {} as never,
        config: {} as never,
        agents: {
          list: vi.fn(async () => ({
            requestId: "req-1",
            subscriptionId: null,
            entries: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          })),
          subscribe: vi.fn(() => () => {}),
        } as never,
      },
    } as unknown as PluginClientContext;

    const cleanup = contributeClient(mockClient);
    expect(typeof cleanup).toBe("function");

    // Surfaces
    expect(surfaces.has("limits")).toBe(true);
    expect(surfaces.has("history")).toBe(true);
    expect(surfaces.has("settings")).toBe(true);

    // v0.8 Settings screen
    expect(settingsScreens.length).toBe(1);
    expect(settingsScreens[0]?.id).toBe("settings");
    expect(settingsScreens[0]?.title).toBe("Usage Monitor");
    expect(settingsScreens[0]?.icon).toBe("Settings2");

    // Sidebar items
    expect(sidebarItems.map((i) => i.id)).toEqual(["limits", "history"]);

    // Workspace panels
    expect(workspacePanels.map((p) => p.id)).toEqual(["limits", "history"]);

    // v0.8 Slash command
    expect(slashCommands.length).toBe(1);
    expect(slashCommands[0]?.name).toBe("usage");
    expect(slashCommands[0]?.context).toBe("workspace");

    // Test slash command onSubmit
    const openPanelMock = vi.fn();
    slashCommands[0]?.onSubmit({ args: "history", openPanel: openPanelMock } as never);
    expect(openPanelMock).toHaveBeenCalledWith("history", { location: "workspace" });

    openPanelMock.mockClear();
    slashCommands[0]?.onSubmit({ args: "", openPanel: openPanelMock } as never);
    expect(openPanelMock).toHaveBeenCalledWith("limits", { location: "workspace" });

    cleanup();
  });
});
