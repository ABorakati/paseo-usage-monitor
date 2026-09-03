import { Icon, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer, type Dispatch } from "react";
import type { ZodError } from "zod";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  readUsageConfig,
  removeUsageProvider,
  testUsageProvider,
  UsageProviderWriteSchema,
  writeUsageProvider,
  type UsageConfigState,
  type UsagePresetSummary,
  type UsageProviderWrite,
} from "./config.shared";
import {
  USAGE_PROVIDER_ID_PATTERN,
  UsageProviderOverrideSchema,
  type UsageDisplay,
  type UsageIcon,
  type UsageProviderOverride,
  type UsageReadingMapping,
  type UsageSource,
} from "./limits.shared";
import { getUsagePreset } from "./presets.shared";

const CONFIG_QUERY_KEY = ["usage-config"];
const LIMITS_QUERY_KEY = ["usage-limits"];
const UNITS = ["tokens", "requests", "credits", "flows", "usd", "percent"];
const READING_KINDS: readonly ReadingDraft["kind"][] = ["quota", "balance", "rate"];
const ACCESS_SELECTED = { selected: true, disabled: false };
const ACCESS_UNSELECTED = { selected: false, disabled: false };
const ACCESS_SELECTED_DISABLED = { selected: true, disabled: true };
const ACCESS_UNSELECTED_DISABLED = { selected: false, disabled: true };
const ACCESS_DISABLED = { disabled: true };
const ACCESS_ENABLED = { disabled: false };
const ACCESS_PRESET_SELECTED = { selected: true };
const ACCESS_PRESET_UNSELECTED = { selected: false };

interface SettingsStyles {
  screen: ViewStyle;
  header: ViewStyle;
  headerTitle: TextStyle;
  body: ViewStyle;
  section: ViewStyle;
  sectionHeader: ViewStyle;
  sectionTitle: TextStyle;
  sectionDetail: TextStyle;
  card: ViewStyle;
  selectedCard: ViewStyle;
  warningCard: ViewStyle;
  row: ViewStyle;
  wrapRow: ViewStyle;
  grow: ViewStyle;
  label: TextStyle;
  text: TextStyle;
  muted: TextStyle;
  success: TextStyle;
  warning: TextStyle;
  error: TextStyle;
  mono: TextStyle;
  input: TextStyle;
  multilineInput: TextStyle;
  button: ViewStyle;
  primaryButton: ViewStyle;
  dangerButton: ViewStyle;
  selectedButton: ViewStyle;
  disabledButton: ViewStyle;
  buttonText: TextStyle;
  primaryButtonText: TextStyle;
  dangerButtonText: TextStyle;
  pill: ViewStyle;
  warningPill: ViewStyle;
  pillText: TextStyle;
  divider: ViewStyle;
  paths: ViewStyle;
  reading: ViewStyle;
  modalOverlay: ViewStyle;
  modalBackdrop: ViewStyle;
  modalPanel: ViewStyle;
  modalHeader: ViewStyle;
  modalTitle: TextStyle;
  modalBody: ViewStyle;
  modalBodyContent: ViewStyle;
  modalFooter: ViewStyle;
  closeButton: ViewStyle;
}

interface ReadingDraft {
  key: string;
  kind: "quota" | "balance" | "rate";
  id: string;
  label: string;
  group: string;
  unit: string;
  usedPath: string;
  limitPath: string;
  remainingPath: string;
  totalPath: string;
  percentPath: string;
  percentRemainingPath: string;
  currencyPath: string;
  statePath: string;
  multiplierPath: string;
  changesAtPath: string;
  detailPath: string;
  windowLabel: string;
  resetsAtPath: string;
  durationMs: string;
  eachPath: string;
  eachIdPath: string;
  eachLabelPath: string;
  eachGroupPath: string;
}

type ReadingTextField = Exclude<keyof ReadingDraft, "key" | "kind">;
type UsageSourceKind = UsageSource["kind"];
type UsageProbeName = Extract<UsageSource, { kind: "probe" }>["probe"];

interface EditorState {
  mode: "idle" | "preset" | "custom";
  editingId: string | null;
  presetId: string | null;
  id: string;
  label: string;
  sourceKind: UsageSourceKind;
  probe: UsageProbeName;
  url: string;
  method: "GET" | "POST";
  headers: string;
  command: string;
  templateEnabled: boolean;
  readings: ReadingDraft[];
  storedSecrets: string[];
  secretValues: Record<string, string>;
  touchedSecrets: Record<string, boolean>;
  replacingSecrets: Record<string, boolean>;
  iconKind: "default" | "lucide" | "monogram" | "image";
  iconLucideName: string;
  iconMonogramText: string;
  iconMonogramColor: string;
  iconImageUri: string;
  displayStyle: "bar" | "ring";
  displayValue: "used" | "remaining";
  display: UsageDisplay | undefined;
}

type EditorAction =
  | { type: "load"; state: EditorState }
  | { type: "close" }
  | { type: "id"; value: string }
  | { type: "label"; value: string }
  | { type: "source-kind"; value: UsageSourceKind }
  | { type: "url"; value: string }
  | { type: "method"; value: "GET" | "POST" }
  | { type: "headers"; value: string }
  | { type: "command"; value: string }
  | { type: "template"; value: boolean }
  | { type: "add-reading"; kind: ReadingDraft["kind"] }
  | { type: "remove-reading"; key: string }
  | { type: "reading-kind"; key: string; kind: ReadingDraft["kind"] }
  | { type: "reading-field"; key: string; field: ReadingTextField; value: string }
  | { type: "replace-secret"; name: string }
  | { type: "secret"; name: string; value: string }
  | { type: "clear-secret"; name: string }
  | { type: "icon-kind"; value: "default" | "lucide" | "monogram" | "image" }
  | { type: "icon-lucide-name"; value: string }
  | { type: "icon-monogram-text"; value: string }
  | { type: "icon-monogram-color"; value: string }
  | { type: "icon-image-uri"; value: string }
  | { type: "display-style"; value: "bar" | "ring" }
  | { type: "display-value"; value: "used" | "remaining" };
interface ProviderTestResult {
  ok: boolean;
  message: string;
  readingCount: number;
}

interface SurfaceState {
  confirmingId: string | null;
  tests: Record<string, ProviderTestResult>;
  formError: string | null;
  notice: string | null;
}

type SurfaceAction =
  | { type: "confirm"; id: string | null }
  | { type: "test"; id: string; result: ProviderTestResult }
  | { type: "error"; message: string | null }
  | { type: "notice"; message: string | null };

interface FieldProps {
  label: string;
  value: string;
  onChangeText(value: string): void;
  styles: SettingsStyles;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
}

interface ChoiceProps {
  label: string;
  selected: boolean;
  onPress(): void;
  styles: SettingsStyles;
  disabled?: boolean;
}

interface ActionButtonProps {
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  styles: SettingsStyles;
  tone?: "normal" | "primary" | "danger";
  disabled?: boolean;
  icon?: string;
}

interface ProviderCardProps {
  id: string;
  entry: UsageProviderOverride;
  preset: UsagePresetSummary | undefined;
  testResult: ProviderTestResult | undefined;
  confirming: boolean;
  testing: boolean;
  styles: SettingsStyles;
  onEdit(id: string): void;
  onTest(id: string): void;
  onConfirm(id: string | null): void;
  onRemove(id: string): void;
}

interface SourceEditorProps {
  editor: EditorState;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface ReadingEditorProps {
  reading: ReadingDraft;
  canRemove: boolean;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface ReadingFieldProps {
  label: string;
  value: string;
  field: ReadingTextField;
  mappingKey: string;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface ReadingKindChoiceProps {
  kind: ReadingDraft["kind"];
  reading: ReadingDraft;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface UnitChoiceProps {
  unit: string;
  reading: ReadingDraft;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface CredentialsEditorProps {
  editor: EditorState;
  preset: UsagePresetSummary;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface ProviderEditorProps {
  editor: EditorState;
  preset: UsagePresetSummary | undefined;
  saving: boolean;
  styles: SettingsStyles;
  dispatch: Dispatch<EditorAction>;
  onSave(): void;
  onCancel(): void;
}

interface PresetPickerProps {
  presets: readonly UsagePresetSummary[];
  selectedId: string | null;
  styles: SettingsStyles;
  onSelect(id: string): void;
  onCustom(): void;
}

interface PillProps {
  label: string;
  warning: boolean;
  styles: SettingsStyles;
}

interface CredentialFieldProps {
  name: string;
  editor: EditorState;
  presetId: string;
  dispatch: Dispatch<EditorAction>;
  styles: SettingsStyles;
}

interface PresetCardProps {
  preset: UsagePresetSummary;
  selected: boolean;
  styles: SettingsStyles;
  onSelect(id: string): void;
}

interface ConfiguredProvidersProps {
  config: UsageConfigState;
  surface: SurfaceState;
  testingId: string | null;
  styles: SettingsStyles;
  onEdit(id: string): void;
  onTest(id: string): void;
  onConfirm(id: string | null): void;
  onRemove(id: string): void;
}
interface PathsProps {
  config: UsageConfigState;
  styles: SettingsStyles;
}

export interface UsageSettingsBodyProps extends PluginSurfaceProps {
  showHeader: boolean;
}

let nextReadingKey = 0;

function readingKey(): string {
  nextReadingKey += 1;
  return `reading-${nextReadingKey}`;
}

function emptyReading(kind: ReadingDraft["kind"] = "quota"): ReadingDraft {
  return {
    key: readingKey(),
    kind,
    id: "usage",
    label: "Usage",
    group: "",
    unit: kind === "rate" ? "percent" : "requests",
    usedPath: "",
    limitPath: "",
    remainingPath: "",
    totalPath: "",
    percentPath: "",
    percentRemainingPath: "",
    currencyPath: "",
    statePath: "",
    multiplierPath: "",
    changesAtPath: "",
    detailPath: "",
    windowLabel: "",
    resetsAtPath: "",
    durationMs: "",
    eachPath: "",
    eachIdPath: "",
    eachLabelPath: "",
    eachGroupPath: "",
  };
}

const CLOSED_EDITOR: EditorState = {
  mode: "idle",
  editingId: null,
  presetId: null,
  id: "",
  label: "",
  sourceKind: "http",
  probe: "antigravity",
  url: "",
  method: "GET",
  headers: "",
  command: "",
  templateEnabled: false,
  readings: [],
  storedSecrets: [],
  secretValues: {},
  touchedSecrets: {},
  replacingSecrets: {},
  iconKind: "default",
  iconLucideName: "",
  iconMonogramText: "",
  iconMonogramColor: "",
  iconImageUri: "",
  displayStyle: "bar",
  displayValue: "used",
  display: undefined,
};

function sourceHeaders(source: UsageSource | undefined): string {
  if (source?.kind !== "http") return "";
  return Object.entries(source.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function sourceCommand(source: UsageSource | undefined): string {
  if (source?.kind !== "command") return "";
  return source.command.join("\n");
}

function mappingDraft(mapping: UsageReadingMapping): ReadingDraft {
  const draft = emptyReading(mapping.kind);
  const common = {
    ...draft,
    id: mapping.id,
    label: mapping.label,
    group: mapping.group ?? "",
  };
  if (mapping.kind === "quota") {
    return {
      ...common,
      unit: mapping.unit,
      usedPath: mapping.usedPath ?? "",
      limitPath: mapping.limitPath ?? "",
      remainingPath: mapping.remainingPath ?? "",
      percentPath: mapping.percentPath ?? "",
      percentRemainingPath: mapping.percentRemainingPath ?? "",
      windowLabel: mapping.window?.label ?? "",
      resetsAtPath: mapping.window?.resetsAtPath ?? "",
      durationMs: mapping.window?.durationMs?.toString() ?? "",
      eachPath: mapping.each?.path ?? "",
      eachIdPath: mapping.each?.idPath ?? "",
      eachLabelPath: mapping.each?.labelPath ?? "",
      eachGroupPath: mapping.each?.groupPath ?? "",
    };
  }
  if (mapping.kind === "balance") {
    return {
      ...common,
      unit: mapping.unit,
      remainingPath: mapping.remainingPath ?? "",
      totalPath: mapping.totalPath ?? "",
      percentRemainingPath: mapping.percentRemainingPath ?? "",
      currencyPath: mapping.currencyPath ?? "",
      eachPath: mapping.each?.path ?? "",
      eachIdPath: mapping.each?.idPath ?? "",
      eachLabelPath: mapping.each?.labelPath ?? "",
      eachGroupPath: mapping.each?.groupPath ?? "",
    };
  }
  if (mapping.resolution.via === "schedule") return common;
  return {
    ...common,
    statePath: mapping.resolution.statePath,
    multiplierPath: mapping.resolution.multiplierPath ?? "",
    changesAtPath: mapping.resolution.changesAtPath ?? "",
    detailPath: mapping.resolution.detailPath ?? "",
  };
}

function customEditor(): EditorState {
  return {
    ...CLOSED_EDITOR,
    mode: "custom",
    id: "my-provider",
    label: "My provider",
    readings: [emptyReading()],
  };
}

function customEditorWithEntry(
  id: string,
  entry: UsageProviderOverride,
  storedSecrets: readonly string[],
): EditorState {
  const source = entry.source;
  const sourceKind = source?.kind ?? "http";
  const icon = entry.display?.icon;
  return {
    ...CLOSED_EDITOR,
    mode: "custom",
    editingId: id,
    presetId: null,
    id,
    label: entry.label ?? id,
    sourceKind,
    probe: source?.kind === "probe" ? source.probe : "antigravity",
    url: source?.kind === "http" ? source.url : "",
    method: source?.kind === "http" ? source.method : "GET",
    headers: sourceHeaders(source),
    command: sourceCommand(source),
    templateEnabled: true,
    readings: (entry.readings ?? []).map(mappingDraft),
    storedSecrets: [...storedSecrets],
    iconKind: icon?.kind ?? "default",
    iconLucideName: icon?.kind === "lucide" ? icon.name : "",
    iconMonogramText: icon?.kind === "monogram" ? icon.text : "",
    iconMonogramColor: icon?.kind === "monogram" ? (icon.color ?? "") : "",
    iconImageUri: icon?.kind === "image" ? icon.uri : "",
    displayStyle: entry.display?.style ?? "bar",
    displayValue: entry.display?.value ?? "used",
    display: entry.display,
  };
}

function presetEditor(
  presetId: string,
  configuredId: string | null,
  entry: UsageProviderOverride | undefined,
  storedSecrets: readonly string[],
): EditorState {
  const preset = getUsagePreset(presetId);
  if (preset === null) return CLOSED_EDITOR;
  const source = entry?.source ?? preset.source;
  const mappings = entry?.readings ?? preset.readings;
  const sourceKind = source?.kind ?? "http";
  const templateEnabled =
    preset.unverified || entry?.source !== undefined || entry?.readings !== undefined;
  const icon = entry?.display?.icon;
  return {
    ...CLOSED_EDITOR,
    mode: "preset",
    editingId: configuredId,
    presetId,
    id: configuredId ?? presetId,
    label: entry?.label ?? preset.label,
    sourceKind,
    probe: source?.kind === "probe" ? source.probe : "antigravity",
    url: source?.kind === "http" ? source.url : "",
    method: source?.kind === "http" ? source.method : "GET",
    headers: sourceHeaders(source),
    command: sourceCommand(source),
    templateEnabled,
    readings: mappings.map(mappingDraft),
    storedSecrets: [...storedSecrets],
    iconKind: icon?.kind ?? "default",
    iconLucideName: icon?.kind === "lucide" ? icon.name : "",
    iconMonogramText: icon?.kind === "monogram" ? icon.text : "",
    iconMonogramColor: icon?.kind === "monogram" ? (icon.color ?? "") : "",
    iconImageUri: icon?.kind === "image" ? icon.uri : "",
    displayStyle: entry?.display?.style ?? "bar",
    displayValue: entry?.display?.value ?? "used",
    display: entry?.display,
  };
}

function updateReading(
  readings: readonly ReadingDraft[],
  key: string,
  update: (reading: ReadingDraft) => ReadingDraft,
): ReadingDraft[] {
  return readings.map((reading) => (reading.key === key ? update(reading) : reading));
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "load") return action.state;
  if (action.type === "close") return CLOSED_EDITOR;
  if (action.type === "id") return { ...state, id: action.value };
  if (action.type === "label") return { ...state, label: action.value };
  if (action.type === "source-kind") return { ...state, sourceKind: action.value };
  if (action.type === "url") return { ...state, url: action.value };
  if (action.type === "method") return { ...state, method: action.value };
  if (action.type === "headers") return { ...state, headers: action.value };
  if (action.type === "command") return { ...state, command: action.value };
  if (action.type === "template") return { ...state, templateEnabled: action.value };
  if (action.type === "add-reading") {
    return { ...state, readings: [...state.readings, emptyReading(action.kind)] };
  }
  if (action.type === "remove-reading") {
    return { ...state, readings: state.readings.filter((reading) => reading.key !== action.key) };
  }
  if (action.type === "reading-kind") {
    const readings = updateReading(state.readings, action.key, (reading) => ({
      ...emptyReading(action.kind),
      key: reading.key,
      id: reading.id,
      label: reading.label,
      group: reading.group,
    }));
    return { ...state, readings };
  }
  if (action.type === "reading-field") {
    const readings = updateReading(state.readings, action.key, (reading) => ({
      ...reading,
      [action.field]: action.value,
    }));
    return { ...state, readings };
  }
  if (action.type === "replace-secret") {
    return {
      ...state,
      replacingSecrets: { ...state.replacingSecrets, [action.name]: true },
    };
  }
  if (action.type === "secret") {
    return {
      ...state,
      secretValues: { ...state.secretValues, [action.name]: action.value },
      touchedSecrets: { ...state.touchedSecrets, [action.name]: true },
    };
  }
  if (action.type === "icon-kind") return { ...state, iconKind: action.value };
  if (action.type === "icon-lucide-name") return { ...state, iconLucideName: action.value };
  if (action.type === "icon-monogram-text") return { ...state, iconMonogramText: action.value };
  if (action.type === "icon-monogram-color") return { ...state, iconMonogramColor: action.value };
  if (action.type === "icon-image-uri") return { ...state, iconImageUri: action.value };
  if (action.type === "display-style") return { ...state, displayStyle: action.value };
  if (action.type === "display-value") return { ...state, displayValue: action.value };
  return {
    ...state,
    secretValues: { ...state.secretValues, [action.name]: "" },
    touchedSecrets: { ...state.touchedSecrets, [action.name]: true },
    replacingSecrets: { ...state.replacingSecrets, [action.name]: false },
  };
}

const INITIAL_SURFACE_STATE: SurfaceState = {
  confirmingId: null,
  tests: {},
  formError: null,
  notice: null,
};

function surfaceReducer(state: SurfaceState, action: SurfaceAction): SurfaceState {
  if (action.type === "confirm") return { ...state, confirmingId: action.id };
  if (action.type === "test") {
    return { ...state, tests: { ...state.tests, [action.id]: action.result } };
  }
  if (action.type === "error") return { ...state, formError: action.message };
  return { ...state, notice: action.message };
}

class UsageFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageFormError";
  }
}

function optionalValue(name: string, value: string): Record<string, string> {
  const trimmed = value.trim();
  return trimmed === "" ? {} : { [name]: trimmed };
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new UsageFormError(`Header "${line}" needs the form Name: value`);
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === "") throw new UsageFormError(`Header "${name}" needs a value`);
    headers[name] = value;
  }
  return headers;
}

function buildSource(editor: EditorState): UsageSource {
  if (editor.sourceKind === "probe") {
    return { kind: "probe", probe: editor.probe };
  }
  if (editor.sourceKind === "http") {
    return {
      kind: "http",
      url: editor.url.trim(),
      method: editor.method,
      headers: parseHeaders(editor.headers),
    };
  }
  const command = editor.command
    .split("\n")
    .map((argument) => argument.trim())
    .filter((argument) => argument !== "");
  return { kind: "command", command };
}

function buildReading(reading: ReadingDraft): unknown {
  const common = {
    kind: reading.kind,
    id: reading.id.trim(),
    label: reading.label.trim(),
    ...optionalValue("group", reading.group),
  };
  if (reading.kind === "quota") {
    const hasPath = [
      reading.usedPath,
      reading.limitPath,
      reading.remainingPath,
      reading.percentPath,
      reading.percentRemainingPath,
    ].some((value) => value.trim() !== "");
    if (!hasPath) throw new UsageFormError(`Quota reading "${reading.label}" needs a value path`);
    const window = buildWindow(reading);
    const each = buildEach(reading);
    return {
      ...common,
      unit: reading.unit,
      ...(window === null ? {} : { window }),
      ...(each === null ? {} : { each }),
      ...optionalValue("usedPath", reading.usedPath),
      ...optionalValue("limitPath", reading.limitPath),
      ...optionalValue("remainingPath", reading.remainingPath),
      ...optionalValue("percentPath", reading.percentPath),
      ...optionalValue("percentRemainingPath", reading.percentRemainingPath),
    };
  }
  if (reading.kind === "balance") {
    const hasPath = [reading.remainingPath, reading.totalPath, reading.percentRemainingPath].some(
      (value) => value.trim() !== "",
    );
    if (!hasPath) throw new UsageFormError(`Balance reading "${reading.label}" needs a value path`);
    const each = buildEach(reading);
    return {
      ...common,
      unit: reading.unit,
      ...(each === null ? {} : { each }),
      ...optionalValue("remainingPath", reading.remainingPath),
      ...optionalValue("totalPath", reading.totalPath),
      ...optionalValue("percentRemainingPath", reading.percentRemainingPath),
      ...optionalValue("currencyPath", reading.currencyPath),
    };
  }
  return {
    ...common,
    resolution: {
      via: "response",
      statePath: reading.statePath.trim(),
      ...optionalValue("multiplierPath", reading.multiplierPath),
      ...optionalValue("changesAtPath", reading.changesAtPath),
      ...optionalValue("detailPath", reading.detailPath),
    },
  };
}

function buildWindow(reading: ReadingDraft): unknown | null {
  const label = reading.windowLabel.trim();
  const resetsAtPath = reading.resetsAtPath.trim();
  const durationText = reading.durationMs.trim();
  const hasWindow = label !== "" || resetsAtPath !== "" || durationText !== "";
  if (!hasWindow) return null;
  if (label === "")
    throw new UsageFormError(`Quota reading "${reading.label}" needs a window label`);
  let durationMs: number | undefined;
  if (durationText !== "") {
    durationMs = Number(durationText);
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new UsageFormError(`Quota reading "${reading.label}" needs a positive duration in ms`);
    }
  }
  return {
    label,
    ...optionalValue("resetsAtPath", resetsAtPath),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function buildEach(reading: ReadingDraft): unknown | null {
  const path = reading.eachPath.trim();
  const hasProjection = [
    path,
    reading.eachIdPath,
    reading.eachLabelPath,
    reading.eachGroupPath,
  ].some((value) => value.trim() !== "");
  if (!hasProjection) return null;
  if (path === "") throw new UsageFormError(`Reading "${reading.label}" needs an array path`);
  return {
    path,
    ...optionalValue("idPath", reading.eachIdPath),
    ...optionalValue("labelPath", reading.eachLabelPath),
    ...optionalValue("groupPath", reading.eachGroupPath),
  };
}

function buildSecrets(editor: EditorState): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, touched] of Object.entries(editor.touchedSecrets)) {
    if (touched) secrets[name] = editor.secretValues[name] ?? "";
  }
  return secrets;
}

function validationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "provider"}: ${issue.message}`)
    .join("; ");
}

function buildProviderWrite(editor: EditorState): UsageProviderWrite {
  if (!USAGE_PROVIDER_ID_PATTERN.test(editor.id)) {
    throw new UsageFormError(
      "Provider id must start with a lowercase letter and use only lowercase letters, numbers, or hyphens.",
    );
  }
  let icon: UsageIcon | undefined;
  if (editor.iconKind === "lucide") {
    if (editor.iconLucideName.trim() !== "") {
      icon = { kind: "lucide", name: editor.iconLucideName.trim() };
    }
  } else if (editor.iconKind === "monogram") {
    if (editor.iconMonogramText.trim() !== "") {
      const color = editor.iconMonogramColor.trim();
      icon = {
        kind: "monogram",
        text: editor.iconMonogramText.trim(),
        ...(color !== "" ? { color } : {}),
      };
    }
  } else if (editor.iconKind === "image") {
    if (editor.iconImageUri.trim() !== "") {
      icon = { kind: "image", uri: editor.iconImageUri.trim() };
    }
  }

  const display: UsageDisplay = { ...editor.display };
  if (icon !== undefined) {
    display.icon = icon;
  } else if (editor.iconKind === "default" && display.icon !== undefined) {
    delete display.icon;
  }
  // Both renderers already read a missing key as the default, so storing the
  // default would only add a line to the config that means nothing.
  if (editor.displayStyle === "bar") delete display.style;
  else display.style = editor.displayStyle;
  if (editor.displayValue === "used") delete display.value;
  else display.value = editor.displayValue;
  const displayProp = Object.keys(display).length > 0 ? { display } : {};

  let candidate: unknown;
  if (editor.mode === "preset" && editor.presetId !== null) {
    candidate = editor.templateEnabled
      ? {
          preset: editor.presetId,
          source: buildSource(editor),
          readings: editor.readings.map(buildReading),
          ...displayProp,
        }
      : { preset: editor.presetId, ...displayProp };
  } else {
    candidate = {
      label: editor.label.trim(),
      source: buildSource(editor),
      readings: editor.readings.map(buildReading),
      ...displayProp,
    };
  }
  const entry = UsageProviderOverrideSchema.safeParse(candidate);
  if (!entry.success) throw new UsageFormError(validationMessage(entry.error));
  const write = UsageProviderWriteSchema.safeParse({
    id: editor.id,
    entry: entry.data,
    secrets: buildSecrets(editor),
  });
  if (!write.success) throw new UsageFormError(validationMessage(write.error));
  return write.data;
}
function Field({
  label,
  value,
  onChangeText,
  styles,
  placeholder,
  secure = false,
  multiline = false,
}: FieldProps) {
  return (
    <View style={styles.paths}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={styles.muted.color}
        secureTextEntry={secure}
        style={multiline ? styles.multilineInput : styles.input}
        value={value}
      />
    </View>
  );
}

function Choice({ label, selected, onPress, styles, disabled = false }: ChoiceProps) {
  let accessibilityState = selected ? ACCESS_SELECTED : ACCESS_UNSELECTED;
  if (disabled) {
    accessibilityState = selected ? ACCESS_SELECTED_DISABLED : ACCESS_UNSELECTED_DISABLED;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        selected ? styles.selectedButton : null,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text style={selected ? styles.primaryButtonText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ActionButton({
  label,
  accessibilityLabel,
  onPress,
  styles,
  tone = "normal",
  disabled = false,
  icon,
}: ActionButtonProps) {
  const isPrimary = tone === "primary";
  const isDanger = tone === "danger";
  const buttonStyle = isPrimary ? styles.primaryButton : styles.button;
  let textStyle = styles.buttonText;
  if (isPrimary) textStyle = styles.primaryButtonText;
  if (isDanger) textStyle = styles.dangerButtonText;
  const iconColor = typeof textStyle.color === "string" ? textStyle.color : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? ACCESS_DISABLED : ACCESS_ENABLED}
      disabled={disabled}
      onPress={onPress}
      style={[
        buttonStyle,
        isDanger ? styles.dangerButton : null,
        disabled ? styles.disabledButton : null,
      ]}
    >
      {icon === undefined || iconColor === undefined ? null : (
        <Icon name={icon} size={14} color={iconColor} />
      )}
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

function Pill({ label, warning, styles }: PillProps) {
  return (
    <View style={[styles.pill, warning ? styles.warningPill : null]}>
      <Text style={warning ? styles.warning : styles.pillText}>{label}</Text>
    </View>
  );
}

function SourceEditor({ editor, dispatch, styles }: SourceEditorProps) {
  const selectHttp = useCallback(
    () => dispatch({ type: "source-kind", value: "http" }),
    [dispatch],
  );
  const selectCommand = useCallback(
    () => dispatch({ type: "source-kind", value: "command" }),
    [dispatch],
  );
  const selectGet = useCallback(() => dispatch({ type: "method", value: "GET" }), [dispatch]);
  const selectPost = useCallback(() => dispatch({ type: "method", value: "POST" }), [dispatch]);
  const changeUrl = useCallback((value: string) => dispatch({ type: "url", value }), [dispatch]);
  const changeHeaders = useCallback(
    (value: string) => dispatch({ type: "headers", value }),
    [dispatch],
  );
  const changeCommand = useCallback(
    (value: string) => dispatch({ type: "command", value }),
    [dispatch],
  );
  if (editor.sourceKind === "probe") {
    return (
      <View style={[styles.card, styles.warningCard]}>
        <View style={styles.wrapRow}>
          <Text style={styles.label}>Source</Text>
          <Pill label="Antigravity probe" warning styles={styles} />
        </View>
        <Text style={styles.text}>Built-in mechanism: Antigravity probe</Text>
        <Text style={styles.warning}>
          Reads the user&apos;s stored Antigravity credential from the OS keyring and calls an
          undocumented Google endpoint. No URL, headers, command, or key is configured here.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={styles.label}>Source</Text>
      <View style={styles.wrapRow}>
        <Choice
          label="HTTP"
          selected={editor.sourceKind === "http"}
          onPress={selectHttp}
          styles={styles}
        />
        <Choice
          label="Command"
          selected={editor.sourceKind === "command"}
          onPress={selectCommand}
          styles={styles}
        />
      </View>
      {editor.sourceKind === "http" ? (
        <View style={styles.paths}>
          <Field label="URL" value={editor.url} onChangeText={changeUrl} styles={styles} />
          <View style={styles.wrapRow}>
            <Choice
              label="GET"
              selected={editor.method === "GET"}
              onPress={selectGet}
              styles={styles}
            />
            <Choice
              label="POST"
              selected={editor.method === "POST"}
              onPress={selectPost}
              styles={styles}
            />
          </View>
          <Field
            label="Headers — one Name: value per line"
            value={editor.headers}
            onChangeText={changeHeaders}
            styles={styles}
            placeholder="Authorization: Bearer ${token}"
            multiline
          />
        </View>
      ) : (
        <Field
          label="Command argv — one argument per line"
          value={editor.command}
          onChangeText={changeCommand}
          styles={styles}
          placeholder={"usage-cli\nstatus\n--json"}
          multiline
        />
      )}
    </View>
  );
}

function ReadingField({ label, value, field, mappingKey, dispatch, styles }: ReadingFieldProps) {
  const change = useCallback(
    (nextValue: string) =>
      dispatch({ type: "reading-field", key: mappingKey, field, value: nextValue }),
    [dispatch, field, mappingKey],
  );
  return <Field label={label} value={value} onChangeText={change} styles={styles} />;
}

function ReadingKindChoice({ kind, reading, dispatch, styles }: ReadingKindChoiceProps) {
  const select = useCallback(
    () => dispatch({ type: "reading-kind", key: reading.key, kind }),
    [dispatch, kind, reading.key],
  );
  return <Choice label={kind} selected={reading.kind === kind} onPress={select} styles={styles} />;
}

function UnitChoice({ unit, reading, dispatch, styles }: UnitChoiceProps) {
  const select = useCallback(
    () => dispatch({ type: "reading-field", key: reading.key, field: "unit", value: unit }),
    [dispatch, reading.key, unit],
  );
  return <Choice label={unit} selected={reading.unit === unit} onPress={select} styles={styles} />;
}

function ReadingEditor({ reading, canRemove, dispatch, styles }: ReadingEditorProps) {
  const remove = useCallback(
    () => dispatch({ type: "remove-reading", key: reading.key }),
    [dispatch, reading.key],
  );
  return (
    <View style={styles.reading}>
      <View style={styles.sectionHeader}>
        <Text style={styles.label}>Reading</Text>
        <ActionButton
          label="Remove"
          onPress={remove}
          styles={styles}
          tone="danger"
          disabled={!canRemove}
        />
      </View>
      <View style={styles.wrapRow}>
        {READING_KINDS.map((kind) => (
          <ReadingKindChoice
            key={kind}
            kind={kind}
            reading={reading}
            dispatch={dispatch}
            styles={styles}
          />
        ))}
      </View>
      <View style={styles.row}>
        <View style={styles.grow}>
          <ReadingField
            label="Reading id"
            value={reading.id}
            field="id"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
        <View style={styles.grow}>
          <ReadingField
            label="Label"
            value={reading.label}
            field="label"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
      </View>
      <ReadingField
        label="Group (optional)"
        value={reading.group}
        field="group"
        mappingKey={reading.key}
        dispatch={dispatch}
        styles={styles}
      />
      {reading.kind === "rate" ? null : (
        <View style={styles.paths}>
          <Text style={styles.muted}>Array projection (optional)</Text>
          <ReadingField
            label="Array path"
            value={reading.eachPath}
            field="eachPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Array item id path"
            value={reading.eachIdPath}
            field="eachIdPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Array item label path"
            value={reading.eachLabelPath}
            field="eachLabelPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Array item group path"
            value={reading.eachGroupPath}
            field="eachGroupPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
      )}
      {reading.kind === "rate" ? null : (
        <View style={styles.wrapRow}>
          {UNITS.map((unit) => (
            <UnitChoice
              key={unit}
              unit={unit}
              reading={reading}
              dispatch={dispatch}
              styles={styles}
            />
          ))}
        </View>
      )}
      {reading.kind === "quota" ? (
        <View style={styles.paths}>
          <ReadingField
            label="Used path"
            value={reading.usedPath}
            field="usedPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Limit path"
            value={reading.limitPath}
            field="limitPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Remaining path"
            value={reading.remainingPath}
            field="remainingPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Percent used path"
            value={reading.percentPath}
            field="percentPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Percent remaining path"
            value={reading.percentRemainingPath}
            field="percentRemainingPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <Text style={styles.muted}>Reset window (optional)</Text>
          <ReadingField
            label="Window label"
            value={reading.windowLabel}
            field="windowLabel"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Reset time path"
            value={reading.resetsAtPath}
            field="resetsAtPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Window duration ms"
            value={reading.durationMs}
            field="durationMs"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
      ) : null}
      {reading.kind === "balance" ? (
        <View style={styles.paths}>
          <ReadingField
            label="Remaining path"
            value={reading.remainingPath}
            field="remainingPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Total path"
            value={reading.totalPath}
            field="totalPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Percent remaining path"
            value={reading.percentRemainingPath}
            field="percentRemainingPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Currency path"
            value={reading.currencyPath}
            field="currencyPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
      ) : null}
      {reading.kind === "rate" ? (
        <View style={styles.paths}>
          <Text style={styles.muted}>Rate readings resolve from the response.</Text>
          <ReadingField
            label="State path"
            value={reading.statePath}
            field="statePath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Multiplier path"
            value={reading.multiplierPath}
            field="multiplierPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Changes-at path"
            value={reading.changesAtPath}
            field="changesAtPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
          <ReadingField
            label="Detail path"
            value={reading.detailPath}
            field="detailPath"
            mappingKey={reading.key}
            dispatch={dispatch}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

function CredentialField({ name, editor, presetId, dispatch, styles }: CredentialFieldProps) {
  const definition = getUsagePreset(presetId);
  const sources = definition?.credentials[name] ?? [];
  const environment = sources.find((source) => source.kind === "env");
  const stored = editor.storedSecrets.includes(name);
  const replacing = editor.replacingSecrets[name] === true;
  const showInput = !stored || replacing;
  const replace = useCallback(() => dispatch({ type: "replace-secret", name }), [dispatch, name]);
  const clear = useCallback(() => dispatch({ type: "clear-secret", name }), [dispatch, name]);
  const change = useCallback(
    (value: string) => dispatch({ type: "secret", name, value }),
    [dispatch, name],
  );
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeader}>
        <Text style={styles.label}>{name}</Text>
        {stored ? <Pill label="Stored" warning={false} styles={styles} /> : null}
      </View>
      {environment === undefined ? null : (
        <View style={styles.paths}>
          <Text style={styles.text}>{`Use environment variable ${environment.variable}`}</Text>
          <Text style={styles.muted}>The environment is checked first when it is available.</Text>
        </View>
      )}
      {sources
        .filter((source) => source.kind === "jsonFile")
        .map((source) => (
          <Text key={`${source.file}#${source.path}`} style={styles.muted}>
            {`Also checks ${source.file}#${source.path}`}
          </Text>
        ))}
      {stored && !replacing ? (
        <ActionButton label="Replace stored value" onPress={replace} styles={styles} />
      ) : null}
      {stored ? (
        <ActionButton
          label={environment === undefined ? "Clear stored value" : "Use environment only"}
          onPress={clear}
          styles={styles}
        />
      ) : null}
      {showInput ? (
        <Field
          label={environment === undefined ? "Store credential here" : "Store a fallback key here"}
          value={editor.secretValues[name] ?? ""}
          onChangeText={change}
          styles={styles}
          placeholder="Write-only — never shown again"
          secure
        />
      ) : null}
    </View>
  );
}

function CredentialsEditor({ editor, preset, dispatch, styles }: CredentialsEditorProps) {
  if (preset.credentialNames.length === 0) return null;
  return (
    <View style={styles.paths}>
      <Text style={styles.label}>Credentials</Text>
      {preset.credentialNames.map((name) => (
        <CredentialField
          key={name}
          name={name}
          editor={editor}
          presetId={preset.id}
          dispatch={dispatch}
          styles={styles}
        />
      ))}
    </View>
  );
}

function ProviderEditor({
  editor,
  preset,
  saving,
  styles,
  dispatch,
  onSave,
  onCancel,
}: ProviderEditorProps) {
  const changeId = useCallback((value: string) => dispatch({ type: "id", value }), [dispatch]);
  const changeLabel = useCallback(
    (value: string) => dispatch({ type: "label", value }),
    [dispatch],
  );
  const chooseIconDefault = useCallback(
    () => dispatch({ type: "icon-kind", value: "default" }),
    [dispatch],
  );
  const chooseIconLucide = useCallback(
    () => dispatch({ type: "icon-kind", value: "lucide" }),
    [dispatch],
  );
  const chooseIconMonogram = useCallback(
    () => dispatch({ type: "icon-kind", value: "monogram" }),
    [dispatch],
  );
  const chooseIconImage = useCallback(
    () => dispatch({ type: "icon-kind", value: "image" }),
    [dispatch],
  );
  const changeIconLucideName = useCallback(
    (value: string) => dispatch({ type: "icon-lucide-name", value }),
    [dispatch],
  );
  const changeIconMonogramText = useCallback(
    (value: string) => dispatch({ type: "icon-monogram-text", value }),
    [dispatch],
  );
  const changeIconMonogramColor = useCallback(
    (value: string) => dispatch({ type: "icon-monogram-color", value }),
    [dispatch],
  );
  const changeIconImageUri = useCallback(
    (value: string) => dispatch({ type: "icon-image-uri", value }),
    [dispatch],
  );
  const chooseMeterBar = useCallback(
    () => dispatch({ type: "display-style", value: "bar" }),
    [dispatch],
  );
  const chooseMeterRing = useCallback(
    () => dispatch({ type: "display-style", value: "ring" }),
    [dispatch],
  );
  const chooseQuotaUsed = useCallback(
    () => dispatch({ type: "display-value", value: "used" }),
    [dispatch],
  );
  const chooseQuotaRemaining = useCallback(
    () => dispatch({ type: "display-value", value: "remaining" }),
    [dispatch],
  );
  const enableTemplate = useCallback(
    () => dispatch({ type: "template", value: !editor.templateEnabled }),
    [dispatch, editor.templateEnabled],
  );
  const addQuota = useCallback(() => dispatch({ type: "add-reading", kind: "quota" }), [dispatch]);
  const addBalance = useCallback(
    () => dispatch({ type: "add-reading", kind: "balance" }),
    [dispatch],
  );
  const addRate = useCallback(() => dispatch({ type: "add-reading", kind: "rate" }), [dispatch]);
  const isPreset = editor.mode === "preset";
  const isProbe = editor.sourceKind === "probe";
  const closeIconColor = typeof styles.muted.color === "string" ? styles.muted.color : undefined;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close provider editor"
          style={styles.modalBackdrop}
          onPress={onCancel}
        />
        <View style={[styles.modalPanel, preset?.unverified ? styles.warningCard : null]}>
          <View style={styles.modalHeader}>
            <View style={styles.grow}>
              <View style={styles.wrapRow}>
                <Text style={styles.modalTitle}>
                  {editor.editingId === null ? "Add provider" : "Edit provider"}
                </Text>
                {preset?.unverified ? <Pill label="Unverified" warning styles={styles} /> : null}
              </View>
              {preset?.unverified ? <Text style={styles.warning}>{preset.description}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close modal"
              onPress={onCancel}
              style={styles.closeButton}
            >
              <Icon name="X" size={16} color={closeIconColor} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.modalBody}
            contentContainerStyle={styles.modalBodyContent}
            keyboardShouldPersistTaps="handled"
          >
            <Field label="Provider id" value={editor.id} onChangeText={changeId} styles={styles} />
            {isPreset ? null : (
              <Field
                label="Label"
                value={editor.label}
                onChangeText={changeLabel}
                styles={styles}
              />
            )}
            <View style={styles.paths}>
              <Text style={styles.label}>Icon & brand mark</Text>
              <View style={styles.wrapRow}>
                <Choice
                  label="Default"
                  selected={editor.iconKind === "default"}
                  onPress={chooseIconDefault}
                  styles={styles}
                />
                <Choice
                  label="Lucide"
                  selected={editor.iconKind === "lucide"}
                  onPress={chooseIconLucide}
                  styles={styles}
                />
                <Choice
                  label="Monogram"
                  selected={editor.iconKind === "monogram"}
                  onPress={chooseIconMonogram}
                  styles={styles}
                />
                <Choice
                  label="Image"
                  selected={editor.iconKind === "image"}
                  onPress={chooseIconImage}
                  styles={styles}
                />
              </View>
              {editor.iconKind === "lucide" ? (
                <Field
                  label="Lucide icon name"
                  value={editor.iconLucideName}
                  onChangeText={changeIconLucideName}
                  placeholder="Gauge"
                  styles={styles}
                />
              ) : null}
              {editor.iconKind === "monogram" ? (
                <>
                  <Field
                    label="Monogram letters"
                    value={editor.iconMonogramText}
                    onChangeText={changeIconMonogramText}
                    placeholder="AI"
                    styles={styles}
                  />
                  <Field
                    label="Plate colour (optional #rrggbb)"
                    value={editor.iconMonogramColor}
                    onChangeText={changeIconMonogramColor}
                    placeholder="#6366F1"
                    styles={styles}
                  />
                </>
              ) : null}
              {editor.iconKind === "image" ? (
                <Field
                  label="Image URI"
                  value={editor.iconImageUri}
                  onChangeText={changeIconImageUri}
                  placeholder="https://… or data:image/png;base64,…"
                  multiline
                  styles={styles}
                />
              ) : null}
            </View>
            <View style={styles.paths}>
              <Text style={styles.label}>Meter</Text>
              <View style={styles.wrapRow}>
                <Choice
                  label="Bar"
                  selected={editor.displayStyle === "bar"}
                  onPress={chooseMeterBar}
                  styles={styles}
                />
                <Choice
                  label="Ring"
                  selected={editor.displayStyle === "ring"}
                  onPress={chooseMeterRing}
                  styles={styles}
                />
              </View>
              <Text style={styles.label}>Quota reads</Text>
              <View style={styles.wrapRow}>
                <Choice
                  label="Used"
                  selected={editor.displayValue === "used"}
                  onPress={chooseQuotaUsed}
                  styles={styles}
                />
                <Choice
                  label="Left"
                  selected={editor.displayValue === "remaining"}
                  onPress={chooseQuotaRemaining}
                  styles={styles}
                />
              </View>
              <Text style={styles.muted}>
                Readings per row follow the card: a wider card shows more columns and a resize
                reflows it, so there is nothing to set here.
              </Text>
            </View>
            {preset === undefined ? null : (
              <CredentialsEditor
                editor={editor}
                preset={preset}
                dispatch={dispatch}
                styles={styles}
              />
            )}
            {isPreset && !isProbe ? (
              <ActionButton
                label={
                  editor.templateEnabled ? "Use preset source and paths" : "Edit source and paths"
                }
                onPress={enableTemplate}
                styles={styles}
                icon="SlidersHorizontal"
              />
            ) : null}
            {editor.templateEnabled || !isPreset ? (
              <View style={styles.paths}>
                <SourceEditor editor={editor} dispatch={dispatch} styles={styles} />
                <View style={styles.sectionHeader}>
                  <Text style={styles.label}>Readings</Text>
                  <View style={styles.wrapRow}>
                    <ActionButton label="Quota" onPress={addQuota} styles={styles} icon="Plus" />
                    <ActionButton
                      label="Balance"
                      onPress={addBalance}
                      styles={styles}
                      icon="Plus"
                    />
                    <ActionButton label="Rate" onPress={addRate} styles={styles} icon="Plus" />
                  </View>
                </View>
                {editor.readings.map((reading) => (
                  <ReadingEditor
                    key={reading.key}
                    reading={reading}
                    canRemove={editor.readings.length > 1}
                    dispatch={dispatch}
                    styles={styles}
                  />
                ))}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.modalFooter}>
            <ActionButton label="Cancel" onPress={onCancel} styles={styles} />
            <ActionButton
              label={saving ? "Saving…" : "Save provider"}
              onPress={onSave}
              styles={styles}
              tone="primary"
              disabled={saving}
              icon="Save"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function PresetCard({ preset, selected, styles, onSelect }: PresetCardProps) {
  const select = useCallback(() => onSelect(preset.id), [onSelect, preset.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected ? ACCESS_PRESET_SELECTED : ACCESS_PRESET_UNSELECTED}
      onPress={select}
      style={[styles.card, selected ? styles.selectedCard : null]}
    >
      <View style={styles.sectionHeader}>
        <Text style={styles.label}>{preset.label}</Text>
        {preset.unverified ? <Pill label="Unverified" warning styles={styles} /> : null}
      </View>
      {preset.description === null ? null : <Text style={styles.muted}>{preset.description}</Text>}
      {preset.endpoint === null ? null : <Text style={styles.mono}>{preset.endpoint}</Text>}
    </Pressable>
  );
}

function PresetPicker({ presets, selectedId, styles, onSelect, onCustom }: PresetPickerProps) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.grow}>
          <Text style={styles.sectionTitle}>Add a provider</Text>
          <Text style={styles.sectionDetail}>
            Start from a known integration or define one from its response shape.
          </Text>
        </View>
        <ActionButton label="Custom provider" onPress={onCustom} styles={styles} icon="Plus" />
      </View>
      <View style={styles.paths}>
        {presets.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            selected={selectedId === preset.id}
            styles={styles}
            onSelect={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

function configuredStatus(
  entry: UsageProviderOverride,
  preset: UsagePresetSummary | undefined,
): string {
  if (entry.enabled === false) return "Disabled";
  if (preset?.unverified) return "Unverified";
  if (entry.preset !== undefined && preset === undefined) return "Unknown preset";
  return entry.preset === undefined ? "Custom" : "Configured";
}

function usesProbeSource(entry: UsageProviderOverride): boolean {
  if (entry.source?.kind === "probe") return true;
  if (entry.preset === undefined) return false;
  return getUsagePreset(entry.preset)?.source?.kind === "probe";
}

function ProviderCard({
  id,
  entry,
  preset,
  testResult,
  confirming,
  testing,
  styles,
  onEdit,
  onTest,
  onConfirm,
  onRemove,
}: ProviderCardProps) {
  const edit = useCallback(() => onEdit(id), [id, onEdit]);
  const test = useCallback(() => onTest(id), [id, onTest]);
  const askRemove = useCallback(() => onConfirm(id), [id, onConfirm]);
  const cancelRemove = useCallback(() => onConfirm(null), [onConfirm]);
  const remove = useCallback(() => onRemove(id), [id, onRemove]);
  const removeAction = usesProbeSource(entry) ? remove : askRemove;
  const label = entry.label ?? preset?.label ?? id;
  const status = configuredStatus(entry, preset);
  const endpoint = entry.source?.kind === "http" ? entry.source.url : preset?.endpoint;
  const warning = status === "Unverified" || status === "Unknown preset";
  return (
    <View style={[styles.card, warning ? styles.warningCard : null]}>
      <View style={styles.sectionHeader}>
        <View style={styles.grow}>
          <View style={styles.wrapRow}>
            <Text style={styles.label}>{label}</Text>
            <Pill label={status} warning={warning} styles={styles} />
          </View>
          <Text style={styles.muted}>{id}</Text>
        </View>
        <View style={styles.wrapRow}>
          <ActionButton label="Edit" onPress={edit} styles={styles} icon="Pencil" />
          <ActionButton
            label={testing ? "Testing…" : "Test"}
            onPress={test}
            styles={styles}
            disabled={testing}
            icon="FlaskConical"
          />
          <ActionButton
            label="Remove"
            onPress={removeAction}
            styles={styles}
            tone="danger"
            icon="Trash2"
          />
        </View>
      </View>
      {endpoint === undefined || endpoint === null ? null : (
        <Text style={styles.mono}>{endpoint}</Text>
      )}
      {confirming ? (
        <View style={styles.warningCard}>
          <Text style={styles.warning}>{`Remove ${label} and its stored secrets?`}</Text>
          <View style={styles.wrapRow}>
            <ActionButton label="Confirm remove" onPress={remove} styles={styles} tone="danger" />
            <ActionButton label="Cancel" onPress={cancelRemove} styles={styles} />
          </View>
        </View>
      ) : null}
      {testResult === undefined ? null : (
        <Text style={testResult.ok ? styles.success : styles.error}>
          {`${testResult.ok ? "Test passed" : "Test failed"}: ${testResult.message} · ${testResult.readingCount} readings`}
        </Text>
      )}
    </View>
  );
}

function ConfiguredProviders({
  config,
  surface,
  testingId,
  styles,
  onEdit,
  onTest,
  onConfirm,
  onRemove,
}: ConfiguredProvidersProps) {
  const presets = new Map(config.presets.map((preset) => [preset.id, preset]));
  const providers = Object.entries(config.providers);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Configured providers</Text>
      {providers.length === 0 ? <Text style={styles.muted}>No providers configured.</Text> : null}
      {providers.map(([id, entry]) => (
        <ProviderCard
          key={id}
          id={id}
          entry={entry}
          preset={entry.preset === undefined ? undefined : presets.get(entry.preset)}
          testResult={surface.tests[id]}
          confirming={surface.confirmingId === id}
          testing={testingId === id}
          styles={styles}
          onEdit={onEdit}
          onTest={onTest}
          onConfirm={onConfirm}
          onRemove={onRemove}
        />
      ))}
    </View>
  );
}

function Paths({ config, styles }: PathsProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Files</Text>
      <View style={styles.paths}>
        <Text style={styles.muted}>Provider config</Text>
        <Text selectable style={styles.mono}>
          {config.configPath}
        </Text>
        <Text style={styles.muted}>Write-only secrets</Text>
        <Text selectable style={styles.mono}>
          {config.secretsPath}
        </Text>
      </View>
    </View>
  );
}

export function UsageSettingsBody({ theme, layout, showHeader }: UsageSettingsBodyProps) {
  const queryClient = useQueryClient();
  const readConfig = useRpc(readUsageConfig);
  const writeProvider = useRpc(writeUsageProvider);
  const removeProvider = useRpc(removeUsageProvider);
  const testProvider = useRpc(testUsageProvider);
  const [editor, dispatchEditor] = useReducer(editorReducer, CLOSED_EDITOR);
  const [surface, dispatchSurface] = useReducer(surfaceReducer, INITIAL_SURFACE_STATE);
  const configQuery = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => readConfig({}),
  });
  const updateQueries = useCallback(
    (state: UsageConfigState) => {
      queryClient.setQueryData(CONFIG_QUERY_KEY, state);
      void queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: LIMITS_QUERY_KEY });
    },
    [queryClient],
  );
  const writeMutation = useMutation({
    mutationFn: (input: UsageProviderWrite) => writeProvider(input),
    onSuccess: (state) => {
      updateQueries(state);
      dispatchEditor({ type: "close" });
      dispatchSurface({ type: "error", message: null });
      dispatchSurface({ type: "notice", message: "Provider saved." });
    },
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeProvider({ id }),
    onSuccess: (state) => {
      updateQueries(state);
      dispatchSurface({ type: "confirm", id: null });
      dispatchSurface({ type: "notice", message: "Provider removed." });
    },
  });
  const testMutation = useMutation({
    mutationFn: (id: string) => testProvider({ id }),
    onSuccess: (result, id) => dispatchSurface({ type: "test", id, result }),
  });

  const styles = useMemo<SettingsStyles>(() => {
    const padding = layout.compact ? 12 : 16;
    const gap = layout.compact ? 8 : 12;
    const fontSize = layout.compact ? 13 : 14;
    const small = layout.compact ? 11 : 12;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        paddingHorizontal: padding,
        paddingVertical: padding,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 17 : 19,
        fontWeight: "600",
      },
      body: { padding, gap },
      section: {
        padding,
        gap,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
      },
      sectionHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap,
      },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 15 : 16,
        fontWeight: "600",
      },
      sectionDetail: { color: theme.colors.foregroundMuted, fontSize: small },
      card: {
        padding,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface2,
      },
      selectedCard: { borderColor: theme.colors.accent },
      warningCard: {
        padding: 10,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        borderRadius: 10,
      },
      row: { flexDirection: layout.compact ? "column" : "row", gap },
      wrapRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
      grow: { flex: 1, minWidth: layout.compact ? undefined : 180, gap: 4 },
      label: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
      text: { color: theme.colors.foreground, fontSize },
      muted: { color: theme.colors.foregroundMuted, fontSize: small },
      success: { color: theme.colors.statusSuccess, fontSize: small },
      warning: { color: theme.colors.statusWarning, fontSize: small },
      error: { color: theme.colors.statusDanger, fontSize: small },
      mono: { color: theme.colors.foregroundMuted, fontSize: small, fontFamily: "monospace" },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize,
      },
      multilineInput: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        minHeight: 76,
        textAlignVertical: "top",
        fontSize,
      },
      button: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      primaryButton: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      dangerButton: { borderColor: theme.colors.statusDanger },
      selectedButton: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      disabledButton: { opacity: 0.5 },
      buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
      primaryButtonText: {
        color: theme.colors.accentForeground,
        fontSize: small,
        fontWeight: "600",
      },
      dangerButtonText: { color: theme.colors.statusDanger, fontSize: small, fontWeight: "600" },
      pill: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      },
      warningPill: { borderWidth: 1, borderColor: theme.colors.statusWarning },
      pillText: { color: theme.colors.foregroundMuted, fontSize: small },
      divider: { height: 1, backgroundColor: theme.colors.border },
      paths: { gap: 8 },
      reading: {
        padding: 10,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      },
      modalOverlay: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: layout.compact ? 12 : 24,
      },
      modalBackdrop: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
      },
      modalPanel: {
        width: "100%",
        maxWidth: layout.compact ? 520 : 640,
        maxHeight: "88%",
        backgroundColor: theme.colors.surface1,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
      },
      modalHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap,
        paddingHorizontal: padding,
        paddingVertical: padding - 2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      modalTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 16 : 18,
        fontWeight: "600",
      },
      modalBody: {
        flexGrow: 0,
        maxHeight: "100%",
      },
      modalBodyContent: {
        padding,
        gap,
      },
      modalFooter: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        paddingHorizontal: padding,
        paddingVertical: padding - 2,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      closeButton: {
        padding: 6,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
      },
    };
  }, [theme, layout.compact]);

  const selectPreset = useCallback((id: string) => {
    dispatchEditor({ type: "load", state: presetEditor(id, null, undefined, []) });
    dispatchSurface({ type: "error", message: null });
    dispatchSurface({ type: "notice", message: null });
  }, []);
  const selectCustom = useCallback(() => {
    dispatchEditor({ type: "load", state: customEditor() });
    dispatchSurface({ type: "error", message: null });
    dispatchSurface({ type: "notice", message: null });
  }, []);
  const editProvider = useCallback(
    (id: string) => {
      const config = configQuery.data;
      const entry = config?.providers[id];
      if (config === undefined || entry === undefined) return;
      const stored = config.storedSecrets[id] ?? [];
      if (entry.preset !== undefined) {
        dispatchEditor({
          type: "load",
          state: presetEditor(entry.preset, id, entry, stored),
        });
      } else {
        dispatchEditor({
          type: "load",
          state: customEditorWithEntry(id, entry, stored),
        });
      }
      dispatchSurface({ type: "error", message: null });
      dispatchSurface({ type: "notice", message: null });
    },
    [configQuery.data],
  );
  const closeEditor = useCallback(() => {
    dispatchEditor({ type: "close" });
    dispatchSurface({ type: "error", message: null });
  }, []);
  const saveEditor = useCallback(() => {
    try {
      const input = buildProviderWrite(editor);
      dispatchSurface({ type: "error", message: null });
      writeMutation.mutate(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchSurface({ type: "error", message });
    }
  }, [editor, writeMutation]);
  const confirmRemove = useCallback((id: string | null) => {
    dispatchSurface({ type: "confirm", id });
  }, []);
  const remove = useCallback(
    (id: string) => {
      dispatchSurface({ type: "error", message: null });
      removeMutation.mutate(id);
    },
    [removeMutation],
  );
  const test = useCallback(
    (id: string) => {
      dispatchSurface({ type: "error", message: null });
      testMutation.mutate(id);
    },
    [testMutation],
  );

  const mutationError = writeMutation.error ?? removeMutation.error ?? testMutation.error;
  const errorMessage =
    surface.formError ?? mutationError?.message ?? configQuery.error?.message ?? null;
  const activePreset = configQuery.data?.presets.find((preset) => preset.id === editor.presetId);

  return (
    <View style={styles.screen}>
      {showHeader ? (
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Usage provider settings</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {configQuery.isPending ? (
          <Text style={styles.muted}>Loading provider settings…</Text>
        ) : null}
        {errorMessage === null ? null : <Text style={styles.error}>{errorMessage}</Text>}
        {surface.notice === null ? null : <Text style={styles.success}>{surface.notice}</Text>}
        {configQuery.data === undefined ? null : (
          <ConfiguredProviders
            config={configQuery.data}
            surface={surface}
            testingId={testMutation.isPending ? testMutation.variables : null}
            styles={styles}
            onEdit={editProvider}
            onTest={test}
            onConfirm={confirmRemove}
            onRemove={remove}
          />
        )}
        {configQuery.data === undefined ? null : (
          <PresetPicker
            presets={configQuery.data.presets}
            selectedId={editor.presetId}
            styles={styles}
            onSelect={selectPreset}
            onCustom={selectCustom}
          />
        )}
        {editor.mode === "idle" ? null : (
          <ProviderEditor
            editor={editor}
            preset={activePreset}
            saving={writeMutation.isPending}
            styles={styles}
            dispatch={dispatchEditor}
            onSave={saveEditor}
            onCancel={closeEditor}
          />
        )}
        {configQuery.data === undefined ? null : (
          <Paths config={configQuery.data} styles={styles} />
        )}
      </ScrollView>
    </View>
  );
}

export function UsageSettingsSurface(props: PluginSurfaceProps) {
  return <UsageSettingsBody {...props} showHeader />;
}
