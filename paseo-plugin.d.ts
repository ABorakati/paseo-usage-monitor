declare module "@getpaseo/plugin" {
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginTheme {
    readonly colors: {
      readonly surface0: string;
      readonly surface1: string;
      readonly surface2: string;
      readonly border: string;
      readonly foreground: string;
      readonly foregroundMuted: string;
      readonly accent: string;
      readonly accentForeground: string;
      readonly statusSuccess: string;
      readonly statusWarning: string;
      readonly statusDanger: string;
    };
  }

  export interface PluginWorkspaceSnapshot {
    readonly id: string;
    readonly projectId: string;
    readonly projectDisplayName: string;
    readonly projectRootPath: string;
    readonly directory: string;
    readonly projectKind: "git" | "non_git" | "directory";
    readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
    readonly name: string;
    readonly title: string | null;
    readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
    readonly statusEnteredAt: string | null;
    readonly archivingAt: string | null;
    readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  }

  export interface PluginAgentSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly provider: string;
    readonly status: "initializing" | "idle" | "running" | "error" | "closed";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly model: string | null;
    readonly currentModeId: string | null;
    readonly thinkingOptionId: string | null;
    readonly requiresAttention: boolean;
    readonly attentionReason: "finished" | "error" | "permission" | null;
    readonly parentAgentId: string | null;
    readonly labels: Readonly<Record<string, string>>;
  }

  export interface PluginThemeColors {
    background: string;
    foreground: string;
    raised: string;
    control: string;
    border: string;
    accent?: string;
    mutedForeground: string;
    ring: string;
  }

  export interface PluginThemeContribution {
    id: string;
    name: string;
    appearance: "light" | "dark";
    colors: PluginThemeColors;
  }

  export interface PluginAttachmentItem {
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  }

  export interface PluginAttachmentSearchPayload {
    items: PluginAttachmentItem[];
  }

  export interface PluginAttachmentSourceContribution {
    id: string;
    title: string;
    icon: string;
    pickerTitle: string;
    searchPlaceholder: string;
    search: PluginRpcContract;
  }

  export type PluginTimelineData =
    | null
    | boolean
    | number
    | string
    | PluginTimelineData[]
    | { [key: string]: PluginTimelineData };

  export interface PluginTimelineItem {
    type: "plugin";
    kind: string;
    version: number;
    data: PluginTimelineData;
  }

  export interface PluginTimelineTransformResult {
    items: PluginTimelineItem[];
  }

  export type PluginCleanup = () => void | Promise<void>;

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  export type RpcInput<Contract extends PluginRpcContract> =
    Contract extends PluginRpcContract<infer InputSchema, ZodType> ? ZodOutput<InputSchema> : never;

  export type RpcOutput<Contract extends PluginRpcContract> =
    Contract extends PluginRpcContract<ZodType, infer OutputSchema>
      ? ZodInput<OutputSchema>
      : never;

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

  export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
    definition: Definition,
  ): Definition;

  export const PluginAttachmentItemSchema: import("zod").ZodType<PluginAttachmentItem>;
  export const PluginAttachmentSearchPayloadSchema: import("zod").ZodType<PluginAttachmentSearchPayload>;

  export interface SettingsDefinition<Schema extends ZodType = ZodType> {
    id: string;
    scope: "host";
    version: number;
    schema: Schema;
    migrate?: (
      stored: unknown,
      fromVersion: number,
    ) => ZodInput<Schema> | Promise<ZodInput<Schema>>;
  }

  export function defineSettings<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): SettingsDefinition<Schema>;
}

declare module "@getpaseo/plugin/client" {
  import type { ComponentType } from "react";
  import type { PaseoApi } from "@getpaseo/client";
  import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
  import type {
    PluginAttachmentSourceContribution,
    PluginCleanup,
    PluginRpcContract,
    PluginTheme,
    PluginThemeContribution,
    PluginTimelineTransformResult,
    PluginWorkspaceSnapshot,
    PluginAgentSnapshot,
    SettingsDefinition,
  } from "@getpaseo/plugin";

  export interface PluginHostProps {
    theme: PluginTheme;
    host: {
      id: string;
      label: string;
    };
    layout: {
      compact: boolean;
      platform: "ios" | "android" | "web";
    };
  }

  export interface PluginNavigableHostProps extends PluginHostProps {
    readonly navigation?: {
      readonly openAgent: (input: { readonly agentId: string }) => void;
      readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
    };
  }

  export interface PluginSurfaceProps extends PluginNavigableHostProps {}

  export interface PluginIconProps {
    name: string;
    size?: number;
    color?: string;
  }

  export type PluginPanelLocation = "workspace" | "explorer";

  export interface PluginOpenPanelOptions {
    location?: PluginPanelLocation;
  }

  export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
    context: "workspace";
    workspaceId: string;
  }

  export interface PluginAgentPanelProps extends PluginNavigableHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
  }

  export interface PluginComposerPillProps extends PluginHostProps {
    workspaceId: string;
    agentId: string;
  }

  export interface PluginComposerPillContribution {
    id: string;
    title: string;
    workspaceId: string;
    agentId: string;
    Component: ComponentType<PluginComposerPillProps>;
    onPress(): void | Promise<void>;
  }

  export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
    workspaceId: string;
    agentId?: string;
  }

  export interface PluginSettingsScreenContribution {
    id: string;
    title: string;
    icon: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginSurfaceContribution {
    id: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    icon: string;
    surface: string;
  }

  export interface PluginWorkspacePanelBase {
    id: string;
    title: string;
    icon: string;
    locations?: readonly PluginPanelLocation[];
  }

  export type PluginWorkspacePanelContribution =
    | (PluginWorkspacePanelBase & {
        context: "workspace";
        Component: ComponentType<PluginWorkspacePanelProps>;
      })
    | (PluginWorkspacePanelBase & {
        context: "agent";
        Component: ComponentType<PluginAgentPanelProps>;
      });

  export type PluginTimelineTransformerContribution<
    ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
  > = ItemType extends AgentTimelineItem["type"]
    ? {
        id: string;
        query: { itemType: ItemType };
        transform(input: {
          item: Extract<AgentTimelineItem, { type: ItemType }>;
          phase: "streaming" | "complete";
        }): PluginTimelineTransformResult | undefined;
      }
    : never;

  export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
    agentId: string;
    item: {
      type: "plugin";
      kind: string;
      version: number;
      data: Data;
    };
    timestamp: Date;
  }

  export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
    kind: string;
    version: number;
    schema: Schema;
    Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
  }

  export interface PluginCommandCapabilities {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    openSurface(id: string): void;
    openSettings(id: string): void;
  }

  export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
    context: "global";
  }

  export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
    context: "workspace";
    workspace: PluginWorkspaceSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  export interface PluginCommandCenterItemBase {
    id: string;
    title: string;
    icon: string;
    keywords?: readonly string[];
  }

  export type PluginCommandCenterItemContribution =
    | (PluginCommandCenterItemBase & {
        context: "global";
        onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
      })
    | (PluginCommandCenterItemBase & {
        context: "workspace";
        onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
      })
    | (PluginCommandCenterItemBase & {
        context: "agent";
        onSelect(context: PluginAgentCommandContext): void | Promise<void>;
      });

  export interface PluginClientSlashCommandBase {
    name: string;
    description: string;
    argumentHint: string;
  }

  export type PluginClientSlashCommandContribution =
    | (PluginClientSlashCommandBase & {
        context: "workspace";
        onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
      })
    | (PluginClientSlashCommandBase & {
        context: "agent";
        onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
      });

  export type SettingsState<Schema extends ZodType> = (
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "invalid"; error: string; revision: string }
    | { status: "ready"; values: ZodOutput<Schema>; revision: string }
  ) & {
    saving: boolean;
    saveError: string | null;
    save(values: ZodOutput<Schema>, revision: string): Promise<boolean>;
    reset(): Promise<boolean>;
    reload(): Promise<void>;
  };

  export interface PluginClientContext extends PluginCommandCapabilities {
    addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
    addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
    addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
    addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
    addTheme(contribution: PluginThemeContribution): PluginCleanup;
    addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
      contribution: PluginTimelineTransformerContribution<ItemType>,
    ): PluginCleanup;
    addTimelineRenderer<Schema extends ZodType>(
      contribution: PluginTimelineRendererContribution<Schema>,
    ): PluginCleanup;
    openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  }

  export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

  export function usePaseo(): PaseoApi;

  export function useWorkspace<Selection>(
    workspaceId: string,
    selector: (workspace: PluginWorkspaceSnapshot) => Selection,
  ): Selection | null;

  export function useAgent<Selection>(
    agentId: string,
    selector: (agent: PluginAgentSnapshot) => Selection,
  ): Selection | null;

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  export function useSettings<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): SettingsState<Schema>;
}

declare module "@getpaseo/plugin/client/react-native" {
  import type {
    ComponentType,
    FunctionComponent,
    ReactNode,
    ForwardRefExoticComponent,
    RefAttributes,
    ReactElement,
    Ref,
  } from "react";
  import type {
    StyleProp,
    ViewStyle,
    ScrollView as NativeScrollView,
    ScrollViewProps,
    FlatList as NativeFlatList,
    FlatListProps,
    TextInput as NativeTextInput,
    TextInputProps,
  } from "react-native";
  import type { PluginIconProps } from "@getpaseo/plugin/client";

  export interface ModalProps {
    title: string;
    icon?: ReactNode;
    open: boolean;
    onOpenChange(open: boolean): void;
    children: ReactNode;
  }

  export interface ModalContentProps {
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    scrollable?: boolean;
  }

  export interface ModalComponent extends FunctionComponent<ModalProps> {
    Content: ComponentType<ModalContentProps>;
  }

  export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

  export interface ToastOptions {
    variant?: ToastVariant;
    durationMs?: number;
  }

  export interface ToastApi {
    show(message: string, options?: ToastOptions): void;
    error(message: string): void;
  }

  export const Icon: ComponentType<PluginIconProps>;
  export const Modal: ModalComponent;
  export function useToast(): ToastApi;
  export function useRevealedText(text: string, phase: "streaming" | "complete"): string;
  export function copyText(text: string): Promise<void>;

  export const ScrollView: ForwardRefExoticComponent<
    ScrollViewProps & RefAttributes<NativeScrollView>
  >;
  export function FlatList<Item>(
    props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
  ): ReactElement;
  export const TextInput: ForwardRefExoticComponent<
    TextInputProps & RefAttributes<NativeTextInput>
  >;

  export type { PluginIconProps };
}

declare module "@getpaseo/plugin/client/ui" {
  import type { ComponentType, ReactNode, Ref } from "react";

  export interface SettingsSectionProps {
    title: string;
    info?: ReactNode;
    trailing?: ReactNode;
    children: ReactNode;
    testID?: string;
  }
  export interface SettingsRowProps {
    label: string;
    hint?: string;
    error?: string | null;
    children?: ReactNode;
    testID?: string;
  }
  export interface SettingsSwitchProps extends SettingsRowProps {
    value: boolean;
    onValueChange(value: boolean): void;
    disabled?: boolean;
  }
  export interface SettingsSelectProps<Value extends string = string> extends SettingsRowProps {
    value: Value;
    options: readonly { label: string; value: Value }[];
    onValueChange(value: Value): void;
    disabled?: boolean;
  }
  export interface SettingsInputHandle {
    focus(): void;
    blur(): void;
    getText(): string;
    replaceText(text: string): void;
  }
  export interface SettingsInputProps extends SettingsRowProps {
    initialValue?: string;
    onChangeText(text: string): void;
    placeholder?: string;
    disabled?: boolean;
    secureTextEntry?: boolean;
    ref?: Ref<SettingsInputHandle>;
  }
  export interface SettingsActionProps extends SettingsRowProps {
    actionLabel: string;
    onPress(): void;
    disabled?: boolean;
  }
  export const SettingsGroup: ComponentType<SettingsSectionProps>;
  export const SettingsSection: ComponentType<SettingsSectionProps>;
  export const SettingsCard: ComponentType<{ children: ReactNode; testID?: string }>;
  export const SettingsRow: ComponentType<SettingsRowProps>;
  export const SettingsSwitch: ComponentType<SettingsSwitchProps>;
  export function SettingsSelect<Value extends string>(
    props: SettingsSelectProps<Value>,
  ): ReactNode;
  export const SettingsInput: ComponentType<SettingsInputProps>;
  export const SettingsAction: ComponentType<SettingsActionProps>;
}

declare module "@getpaseo/plugin/server" {
  import type { PaseoApi } from "@getpaseo/client";
  import type {
    AgentPermissionRequest,
    AgentPermissionResponse,
    AgentTimelineItem,
    AgentSessionConfig,
  } from "@getpaseo/protocol/agent-types";
  import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
  import type { PluginCleanup, PluginRpcContract, SettingsDefinition } from "@getpaseo/plugin";

  export interface PluginHandlerContext {
    paseo: PaseoApi;
  }

  export interface PluginHookContext {
    paseo: PaseoApi;
    signal: AbortSignal;
  }

  export interface PluginHookWorkspace {
    id: string;
    projectId: string;
    cwd: string;
    name: string | null;
    archivedAt: string | null;
  }

  export interface PluginHookAgent {
    id: string;
    workspaceId: string | null;
    parentAgentId: string | null;
    provider: string;
    cwd: string;
    title: string | null;
  }

  export interface PluginSessionOpenRequest {
    agentId: string;
    workspaceId: string | null;
    provider: string;
    cwd: string;
    reason: "create" | "resume" | "refresh" | "import";
    purpose: "interactive" | "history";
    env: Record<string, string>;
  }

  export type PluginTurnOutcome =
    | { kind: "completed" }
    | { kind: "failed"; error: { message: string; code?: string } }
    | { kind: "canceled"; reason: string };

  export interface PluginLifecycleEvents {
    "agent.created": { agent: PluginHookAgent };
    "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
    "agent.turn_ended": {
      agent: PluginHookAgent;
      turnId: string | null;
      outcome: PluginTurnOutcome;
      timeline: readonly AgentTimelineItem[];
    };
    "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
    "agent.permission_resolved": {
      agent: PluginHookAgent;
      requestId: string;
      resolution: AgentPermissionResponse;
    };
    "agent.archived": { agent: PluginHookAgent; archivedAt: string };
    "workspace.created": { workspace: PluginHookWorkspace };
    "workspace.archived": { workspace: PluginHookWorkspace };
  }

  export interface PluginBeforeRequests {
    "agent.create": { config: AgentSessionConfig; env?: Record<string, string> };
    "agent.session_open": PluginSessionOpenRequest;
    "workspace.create": WorkspaceCreateRequest;
  }

  export interface PluginLifecycleRegistration {
    on<EventName extends keyof PluginLifecycleEvents>(
      event: EventName,
      callback: (
        data: PluginLifecycleEvents[EventName],
        context: PluginHookContext,
      ) => void | Promise<void>,
    ): PluginCleanup;
    before<RequestName extends keyof PluginBeforeRequests>(
      request: RequestName,
      callback: (
        data: { request: PluginBeforeRequests[RequestName] },
        context: PluginHookContext,
      ) =>
        | PluginBeforeRequests[RequestName]
        | undefined
        | Promise<PluginBeforeRequests[RequestName] | undefined>,
    ): PluginCleanup;
  }

  export interface PluginServerContext extends PluginLifecycleRegistration {
    registerSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>): void;
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
  }

  export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
}
