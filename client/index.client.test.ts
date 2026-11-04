import { describe, expect, test, vi } from "vitest";
import contributeClient from "../index.client";
import type {
  PluginClientContext,
  PluginSettingsScreenContribution,
  PluginClientSlashCommandContribution,
  PluginScreenContribution,
  PluginSidebarItemContribution,
  PluginWorkspacePanelContribution,
  PluginCommandCenterItemContribution,
} from "@getpaseo/plugin/client";

// The sidebar rows are called as plain functions here, outside a React render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));

describe("index.client v0.15 entry point", () => {
  test("registers all surfaces, settings screens, panels, commands, and slash command", () => {
    const screens: PluginScreenContribution[] = [];
    const settingsScreens: PluginSettingsScreenContribution[] = [];
    const sidebarItems: PluginSidebarItemContribution[] = [];
    const workspacePanels: PluginWorkspacePanelContribution[] = [];
    const commandCenterItems: PluginCommandCenterItemContribution[] = [];
    const slashCommands: PluginClientSlashCommandContribution[] = [];

    const mockClient = {
      addScreen: vi.fn((contribution) => {
        screens.push(contribution);
        return () => {};
      }),
      addSettingsScreen: vi.fn((contribution) => {
        settingsScreens.push(contribution);
        return () => {};
      }),
      addSidebarHeaderItem: vi.fn((contribution) => {
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
      openScreen: vi.fn(),
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

    // Screens
    expect(screens.map((screen) => screen.id)).toEqual(["limits", "history", "settings"]);
    expect(screens.every((screen) => typeof screen.Component === "function")).toBe(true);

    // v0.8 Settings screen
    expect(settingsScreens.length).toBe(1);
    expect(settingsScreens[0]?.id).toBe("settings");
    expect(settingsScreens[0]?.title).toBe("Usage Monitor");
    expect(settingsScreens[0]?.icon).toBe("Settings2");

    // Sidebar items
    expect(sidebarItems.map((i) => i.id)).toEqual(["limits", "history"]);
    expect(sidebarItems.map((i) => i.title)).toEqual(["Usage Monitor", "Usage history"]);

    // A sidebar row opens its own screen and is active only while it is open.
    const openScreen = vi.fn();
    const historyRow = sidebarItems[1]?.Component as unknown as (
      props: Record<string, unknown>,
    ) => { props: { active: boolean; onPress(): void } };
    const row = historyRow({ currentScreen: { screenId: "history", params: {} }, openScreen });
    expect(row.props.active).toBe(true);
    row.props.onPress();
    expect(openScreen).toHaveBeenCalledWith({ screenId: "history" });
    expect(historyRow({ currentScreen: null, openScreen }).props.active).toBe(false);

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
