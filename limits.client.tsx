import {
  Icon,
  useRpc,
  type PluginSurfaceProps,
  type PluginTheme,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  AppState,
  Image,
  PanResponder,
  Platform,
  ScrollView,
  Text,
  View,
  type AppStateStatus,
  type GestureResponderEvent,
  type ImageStyle,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { formatUsageAmount } from "./amount.shared";
import { readUsageConfig, writeUsageProvider, type UsageConfigState } from "./config.shared";
import {
  readUsageLimits,
  type UsageBalanceReading,
  type UsageDisplay,
  type UsageIcon,
  type UsageProviderSnapshot,
  type UsageProviderStatus,
  type UsageQuotaReading,
  type UsageRateReading,
  type UsageReading,
  type UsageSnapshot,
  type UsageWindow,
} from "./limits.shared";
import { UsageMeter, clampPercent } from "./meter.client";
import { UsageHistorySurface } from "./history.client";
import { setTooltipTitle, TooltipPressable as Pressable } from "./tooltip.client";
import { UsageSettingsBody } from "./settings.client";

const USAGE_LIMITS_QUERY_KEY = ["usage-limits", "snapshot"];
const USAGE_CONFIG_QUERY_KEY = ["usage-config"];
const EM_DASH = "—";
const DAY_MS = 86_400_000;
const MIN_CARD_WIDTH = 300;
/**
 * Reordering and resizing are pointer gestures by design — the user asked for
 * drag and drop rather than a row of buttons. These actions keep both reachable
 * from a keyboard or screen reader without putting controls back on the card.
 */
const CARD_ACCESSIBILITY_ACTIONS = [
  { name: "moveEarlier", label: "Move earlier" },
  { name: "moveLater", label: "Move later" },
  { name: "narrower", label: "Make narrower" },
  { name: "wider", label: "Make wider" },
] as const;

const RESIZE_EDGE_THICKNESS = 10;
const RESIZE_CORNER_SIZE = 16;
const MIN_RESIZED_CARD_WIDTH = 240;
const CARD_RESIZE_STEP = 80;
const MIN_RESIZED_CARD_HEIGHT = 260;
const MAX_RESIZED_CARD_HEIGHT = 1_000;
const DRAG_ROW_STEP = 260;
const REFRESH_IDLE_STATE = { disabled: false };
const REFRESH_BUSY_STATE = { disabled: true };
const DISPLAY_SELECTED_STATE = { selected: true };
const DISPLAY_UNSELECTED_STATE = { selected: false };
const ICON_BUTTON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };
const BACK_BUTTON_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };
const TAB_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 };
const DRAG_HANDLE_HIT_SLOP = { top: 11, bottom: 11, left: 11, right: 11 };
const EMPTY_PAN_HANDLERS = {};
/** The server holds a per-provider TTL, so a poll inside it is served from cache. */
const LIMITS_POLL_MS = 60_000;

/**
 * A backoff is the provider refusing politely, not the button breaking, so the
 * control stays pressable and only says what it will run into.
 */
function refreshLabel(isBusy: boolean, rateLimited: boolean): string {
  if (isBusy) {
    return "Refreshing usage limits";
  }
  if (rateLimited) {
    return "Refresh usage limits, a provider is rate limited";
  }
  return "Refresh usage limits";
}

/**
 * The server's number, not a prettied one: a quota genuinely over its limit has
 * to read as over, and a decimal only appears when there is one to show.
 */
function formatPercent(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}%`;
  }
  return `${value.toFixed(1)}%`;
}

function formatDurationShort(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m`;
  }
  return "under a minute";
}

/**
 * Near-term deadlines read better as a countdown, distant ones as a date: a
 * weekly window that resets "in 143h 12m" tells nobody anything.
 */
function formatWhenHint(prefix: string, timestamp: string | null, now: number): string | null {
  if (timestamp === null) {
    return null;
  }
  const targetMs = Date.parse(timestamp);
  if (Number.isNaN(targetMs)) {
    return null;
  }
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) {
    return `${prefix} now`;
  }
  if (remainingMs < DAY_MS) {
    return `${prefix} in ${formatDurationShort(remainingMs)}`;
  }
  const date = new Date(targetMs);
  return `${prefix} ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function formatUpdatedAgo(timestamp: string | null, now: number): string | null {
  if (timestamp === null) {
    return null;
  }
  const fetchedMs = Date.parse(timestamp);
  if (Number.isNaN(fetchedMs)) {
    return null;
  }
  const elapsedMs = now - fetchedMs;
  if (elapsedMs < 60_000) {
    return "Updated just now";
  }
  return `Updated ${formatDurationShort(elapsedMs)} ago`;
}

/**
 * Readings survive a provider backoff, so a card can hold real numbers that are
 * no longer current. Only an `ok` provider is in that position: an `error` one
 * has nothing cached to go stale.
 */
function isShowingStaleReadings(provider: UsageProviderSnapshot): boolean {
  return provider.notice !== null && provider.status === "ok";
}

function formatUpdatedLabel(timestamp: string | null, now: number, stale: boolean): string | null {
  const updated = formatUpdatedAgo(timestamp, now);
  if (updated === null) {
    return null;
  }
  if (stale) {
    return `Stale · ${updated}`;
  }
  return updated;
}

/**
 * A quota with no ceiling still has a number worth showing. Some vendors
 * publish consumption without publishing the plan's limit, and a card that
 * printed a dash for those would hide the only figure it had.
 */
function formatQuotaValue(
  reading: UsageQuotaReading,
  valueMode: NonNullable<UsageDisplay["value"]>,
): string {
  const suffix = valueMode === "used" ? "used" : "left";
  if (reading.percent !== null) {
    const filled = valueMode === "used" ? reading.percent : 100 - reading.percent;
    return `${formatPercent(filled)} ${suffix}`;
  }
  const amount = valueMode === "used" ? reading.used : reading.remaining;
  if (amount === null) return EM_DASH;
  return `${formatUsageAmount(amount, reading.unit)} ${suffix}`;
}

function formatBalanceAmount(reading: UsageBalanceReading): string {
  if (reading.remaining === null) {
    return EM_DASH;
  }
  return formatUsageAmount(reading.remaining, reading.unit, reading.currency);
}

/**
 * Where even consumption would sit inside the window right now, so a bar that
 * is 80% full an hour into a five-hour window reads as burning too fast. A
 * window that has already ended gets no marker: pinning it at the far right
 * would claim the run finished exactly on pace.
 */
function quotaPacePercent(window: UsageWindow | null, now: number): number | null {
  if (window === null || window.resetsAt === null || window.durationMs === null) {
    return null;
  }
  if (window.durationMs <= 0) {
    return null;
  }
  const resetsAtMs = Date.parse(window.resetsAt);
  if (Number.isNaN(resetsAtMs) || resetsAtMs <= now) {
    return null;
  }
  const elapsedMs = window.durationMs - (resetsAtMs - now);
  return clampPercent((elapsedMs / window.durationMs) * 100);
}

interface ReadingGroup {
  key: string;
  label: string | null;
  readings: UsageReading[];
}

/**
 * Ungrouped readings lead, then each `group` in first-appearance order. The
 * server emits readings in config order; nothing else re-sorts them.
 */
function groupReadings(readings: readonly UsageReading[]): ReadingGroup[] {
  const ungrouped: UsageReading[] = [];
  const labelled: ReadingGroup[] = [];
  const byLabel = new Map<string, ReadingGroup>();

  for (const reading of readings) {
    if (reading.group === null) {
      ungrouped.push(reading);
      continue;
    }
    const existing = byLabel.get(reading.group);
    if (existing) {
      existing.readings.push(reading);
      continue;
    }
    const group: ReadingGroup = { key: reading.group, label: reading.group, readings: [reading] };
    byLabel.set(reading.group, group);
    labelled.push(group);
  }

  if (ungrouped.length === 0) {
    return labelled;
  }
  return [{ key: "ungrouped", label: null, readings: ungrouped }, ...labelled];
}

interface UsageStyles {
  screen: ViewStyle;
  header: ViewStyle;
  headerActions: ViewStyle;
  tabs: ViewStyle;
  tab: ViewStyle;
  tabSelected: ViewStyle;
  tabText: TextStyle;
  tabTextSelected: TextStyle;
  back: ViewStyle;
  headerTitle: TextStyle;
  refresh: ViewStyle;
  refreshBusy: ViewStyle;
  body: ViewStyle;
  cardGrid: ViewStyle;
  cardSlot: ViewStyle;
  draggingCard: ViewStyle;
  resizingCard: ViewStyle;
  card: ViewStyle;
  sizedCard: ViewStyle;
  cardContent: ViewStyle;
  cardScroller: ViewStyle;
  cardHeader: ViewStyle;
  identity: ViewStyle;
  dragHandle: ViewStyle;
  moveControls: ViewStyle;
  iconButton: ViewStyle;
  resizeEdgeRight: ViewStyle;
  resizeEdgeBottom: ViewStyle;
  resizeCorner: ViewStyle;
  providerMark: ViewStyle;
  providerImage: ImageStyle;
  providerMonogram: ViewStyle;
  providerMonogramText: TextStyle;
  providerLabel: TextStyle;
  description: TextStyle;
  dotOk: ViewStyle;
  dotWarning: ViewStyle;
  dotDanger: ViewStyle;
  pill: ViewStyle;
  pillText: TextStyle;
  group: ViewStyle;
  groupLabel: TextStyle;
  readingGrid: ViewStyle;
  readingCell1: ViewStyle;
  readingCell2: ViewStyle;
  readingCell3: ViewStyle;
  readingCell4: ViewStyle;
  rows: ViewStyle;
  row: ViewStyle;
  rowHeader: ViewStyle;
  rowTitle: ViewStyle;
  rowLabel: TextStyle;
  qualifier: TextStyle;
  value: TextStyle;
  trailing: ViewStyle;
  hint: TextStyle;
  error: TextStyle;
  emptyTitle: TextStyle;
  notice: TextStyle;
  detail: TextStyle;
}

interface UsageRowChrome {
  styles: UsageStyles;
  theme: PluginTheme;
  compact: boolean;
  now: number;
  display: UsageDisplay;
}

interface UsageDisplayCommit {
  providerId: string;
  display: UsageDisplay;
  previous: UsageDisplay;
}

interface ProviderCardSize {
  width: number;
  height?: number;
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

interface ProviderMarkProps {
  icon: UsageIcon | null;
  fallbackText: string;
  theme: PluginTheme;
  compact: boolean;
  styles: UsageStyles;
}

function StatusDot({
  status,
  hasNotice,
  styles,
}: {
  status: UsageProviderStatus;
  hasNotice: boolean;
  styles: UsageStyles;
}) {
  if (status === "error") {
    return <View style={styles.dotDanger} />;
  }
  if (hasNotice || status === "disabled") {
    return <View style={styles.dotWarning} />;
  }
  return <View style={styles.dotOk} />;
}

function Pill({ label, styles }: { label: string; styles: UsageStyles }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

function fallbackMonogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  const second = words.length > 1 ? (words[1]?.charAt(0) ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

function parseHexColor(value: string): RgbColor | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}

function linearSrgbChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * linearSrgbChannel(color.red) +
    0.7152 * linearSrgbChannel(color.green) +
    0.0722 * linearSrgbChannel(color.blue)
  );
}

function contrastRatio(left: RgbColor, right: RgbColor): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function monogramForeground(plate: string, theme: PluginTheme): string {
  const plateColor = parseHexColor(plate);
  const foreground = parseHexColor(theme.colors.foreground);
  const accentForeground = parseHexColor(theme.colors.accentForeground);
  if (plateColor === null || (foreground === null && accentForeground === null)) {
    return theme.colors.accentForeground;
  }
  if (foreground === null) return theme.colors.accentForeground;
  if (accentForeground === null) return theme.colors.foreground;
  const accentContrast = contrastRatio(plateColor, accentForeground);
  if (accentContrast >= 3) return theme.colors.accentForeground;
  return contrastRatio(plateColor, foreground) > accentContrast
    ? theme.colors.foreground
    : theme.colors.accentForeground;
}

function ProviderMark({ icon, fallbackText, theme, compact, styles }: ProviderMarkProps) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const size = compact ? 24 : 28;
  const imageFailed = icon?.kind === "image" && failedUri === icon.uri;
  const mark: UsageIcon =
    icon === null || imageFailed ? { kind: "monogram", text: fallbackText } : icon;
  const imageUri = icon?.kind === "image" ? icon.uri : "";
  const imageSource = useMemo(() => ({ uri: imageUri }), [imageUri]);
  const imageError = useCallback(() => {
    if (icon?.kind === "image") setFailedUri(icon.uri);
  }, [icon]);

  if (mark.kind === "lucide") {
    return (
      <View
        accessibilityLabel={`Provider mark: ${mark.name}`}
        style={[styles.providerMark, { width: size, height: size }]}
      >
        <Icon name={mark.name} size={compact ? 16 : 18} color={theme.colors.accent} />
      </View>
    );
  }
  if (mark.kind === "image") {
    return (
      <Image
        accessibilityLabel="Provider mark: custom image"
        source={imageSource}
        resizeMode="contain"
        onError={imageError}
        style={[styles.providerImage, { width: size, height: size }]}
      />
    );
  }
  const plateColor = mark.color ?? theme.colors.accent;
  return (
    <View
      accessibilityLabel={`Provider mark: ${mark.text}`}
      style={[styles.providerMonogram, { width: size, height: size, backgroundColor: plateColor }]}
    >
      <Text style={[styles.providerMonogramText, { color: monogramForeground(plateColor, theme) }]}>
        {mark.text.toUpperCase()}
      </Text>
    </View>
  );
}

function QuotaRow({
  reading,
  styles,
  theme,
  compact,
  now,
  display,
}: UsageRowChrome & { reading: UsageQuotaReading }) {
  const resetHint = formatWhenHint("Resets", reading.window?.resetsAt ?? null, now);
  const valueMode = display.value ?? "used";
  const percentFilled =
    reading.percent === null || valueMode === "used" ? reading.percent : 100 - reading.percent;
  const pace = quotaPacePercent(reading.window, now);
  const pacePercent = pace === null || valueMode === "used" ? pace : 100 - pace;
  const valueLabel = formatQuotaValue(reading, valueMode);
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowTitle}>
          <Text style={styles.rowLabel}>{reading.label}</Text>
          {reading.window === null ? null : (
            <Text style={styles.qualifier}>{reading.window.label}</Text>
          )}
        </View>
        <Text style={styles.value}>{valueLabel}</Text>
      </View>
      {reading.percent === null ? null : (
        <UsageMeter
          percentUsed={reading.percent}
          percentFilled={percentFilled ?? reading.percent}
          pacePercent={pacePercent}
          style={display.style ?? "bar"}
          theme={theme}
          compact={compact}
        />
      )}
      {resetHint === null ? null : <Text style={styles.hint}>{resetHint}</Text>}
    </View>
  );
}

function BalanceRow({
  reading,
  styles,
  theme,
  compact,
  display,
}: Omit<UsageRowChrome, "now"> & { reading: UsageBalanceReading }) {
  const remaining = reading.percentRemaining;
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{reading.label}</Text>
        <Text style={styles.value}>{formatBalanceAmount(reading)}</Text>
      </View>
      {remaining === null ? null : (
        <UsageMeter
          percentUsed={100 - clampPercent(remaining)}
          percentFilled={remaining}
          pacePercent={null}
          style={display.style ?? "bar"}
          theme={theme}
          compact={compact}
        />
      )}
      {remaining === null ? null : (
        <Text style={styles.hint}>{`${formatPercent(remaining)} remaining`}</Text>
      )}
    </View>
  );
}

function RateRow({
  reading,
  styles,
  now,
}: Pick<UsageRowChrome, "styles" | "now"> & { reading: UsageRateReading }) {
  const changeHint = formatWhenHint("Changes", reading.changesAt, now);
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{reading.label}</Text>
        <View style={styles.trailing}>
          <Pill label={reading.state} styles={styles} />
          {reading.multiplier === null ? null : (
            <Text style={styles.value}>{`×${reading.multiplier}`}</Text>
          )}
        </View>
      </View>
      {reading.detail === null ? null : <Text style={styles.hint}>{reading.detail}</Text>}
      {changeHint === null ? null : <Text style={styles.hint}>{changeHint}</Text>}
    </View>
  );
}

function ReadingRow({
  reading,
  styles,
  theme,
  compact,
  now,
  display,
}: UsageRowChrome & { reading: UsageReading }) {
  if (reading.kind === "quota") {
    return (
      <QuotaRow
        reading={reading}
        styles={styles}
        theme={theme}
        compact={compact}
        now={now}
        display={display}
      />
    );
  }
  if (reading.kind === "balance") {
    return (
      <BalanceRow
        reading={reading}
        styles={styles}
        theme={theme}
        compact={compact}
        display={display}
      />
    );
  }
  return <RateRow reading={reading} styles={styles} now={now} />;
}

/**
 * The widest a single reading may be squeezed before the grid drops a column.
 * Below this a bar loses its label and a ring loses its centre figure, so the
 * card reflows to fewer, readable columns instead of more, unreadable ones.
 */
const MIN_READING_WIDTH = 168;

/**
 * Columns follow the card, so resizing reflows it and nothing is stored. A card
 * that has not been measured yet renders one column rather than guessing.
 */
export function autoColumns(cardWidth: number, padding: number): number {
  if (!Number.isFinite(cardWidth) || cardWidth <= 0) return 1;
  const inner = cardWidth - padding * 2;
  if (inner <= 0) return 1;
  return Math.max(1, Math.min(4, Math.floor(inner / MIN_READING_WIDTH)));
}

function readingCellStyle(styles: UsageStyles, columns: number): ViewStyle {
  if (columns === 2) return styles.readingCell2;
  if (columns === 3) return styles.readingCell3;
  if (columns === 4) return styles.readingCell4;
  return styles.readingCell1;
}

function ReadingGroups({
  readings,
  styles,
  theme,
  compact,
  now,
  display,
  columns,
}: UsageRowChrome & { readings: readonly UsageReading[]; columns: number }) {
  const cellStyle = readingCellStyle(styles, columns);
  return (
    <View style={styles.rows}>
      {groupReadings(readings).map((group) => (
        <View key={group.key} style={styles.group}>
          {group.label === null ? null : <Text style={styles.groupLabel}>{group.label}</Text>}
          <View style={styles.readingGrid}>
            {group.readings.map((reading) => (
              <View key={reading.id} style={cellStyle}>
                <ReadingRow
                  reading={reading}
                  styles={styles}
                  theme={theme}
                  compact={compact}
                  now={now}
                  display={display}
                />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * With a notice present the notice is the explanation, so the transport error
 * drops to a detail line under the readings instead of standing in for them.
 */
function ProviderBody({
  provider,
  styles,
  theme,
  compact,
  now,
  display,
  columns,
}: UsageRowChrome & { provider: UsageProviderSnapshot; columns: number }) {
  if (provider.notice !== null) {
    return (
      <>
        {provider.readings.length === 0 ? (
          <Text style={styles.hint}>No earlier reading stored.</Text>
        ) : (
          <ReadingGroups
            readings={provider.readings}
            styles={styles}
            theme={theme}
            compact={compact}
            now={now}
            display={display}
            columns={columns}
          />
        )}
        {provider.error === null ? null : (
          <Text style={styles.detail}>{`Detail: ${provider.error}`}</Text>
        )}
      </>
    );
  }
  if (provider.status === "error") {
    return <Text style={styles.error}>{provider.error ?? "The host reported no reason."}</Text>;
  }
  if (provider.status === "disabled") {
    return <Text style={styles.hint}>Disabled</Text>;
  }
  if (provider.readings.length === 0) {
    return <Text style={styles.hint}>No readings reported</Text>;
  }
  return (
    <ReadingGroups
      readings={provider.readings}
      styles={styles}
      theme={theme}
      compact={compact}
      now={now}
      display={display}
      columns={columns}
    />
  );
}

interface ProviderCardProps extends UsageRowChrome {
  provider: UsageProviderSnapshot;
  cardWidth: number | "100%";
  cardHeight: number | undefined;
  dragging: boolean;
  resizing: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDragStart(providerId: string): void;
  onDragEnd(providerId: string, dx: number, dy: number): void;
  onMove(providerId: string, direction: -1 | 1): void;
  onResizeStart(providerId: string): void;
  onResize(providerId: string, width: number, height?: number): void;
  onResizeEnd(): void;
}

function ProviderCard({
  provider,
  cardWidth,
  cardHeight,
  dragging,
  resizing,
  canMoveUp,
  canMoveDown,
  styles,
  theme,
  compact,
  now,
  display,
  onDragStart,
  onDragEnd,
  onMove,
  onResizeStart,
  onResize,
  onResizeEnd,
}: ProviderCardProps) {
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const drag = useRef(new Animated.ValueXY()).current;
  const draggingRef = useRef(dragging);
  const cardWidthRef = useRef(cardWidth);
  const cardHeightRef = useRef(cardHeight);
  const measuredCardRef = useRef({ width: 0, height: 0 });
  const resizeOriginRef = useRef({ width: 0, height: 0 });
  const onResizeRef = useRef(onResize);
  const onResizeStartRef = useRef(onResizeStart);
  const onResizeEndRef = useRef(onResizeEnd);
  draggingRef.current = dragging;
  cardWidthRef.current = cardWidth;
  cardHeightRef.current = cardHeight;
  onResizeRef.current = onResize;
  onResizeStartRef.current = onResizeStart;
  onResizeEndRef.current = onResizeEnd;
  const startDrag = useCallback(
    () => onDragStart(provider.providerId),
    [onDragStart, provider.providerId],
  );
  const finishDrag = useCallback(
    (dx: number, dy: number) => {
      drag.setValue({ x: 0, y: 0 });
      onDragEnd(provider.providerId, dx, dy);
    },
    [drag, onDragEnd, provider.providerId],
  );
  const dragGripResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !compact,
        onMoveShouldSetPanResponder: () => !compact,
        onPanResponderGrant: () => {
          if (compact) return;
          onDragStart(provider.providerId);
          drag.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
          if (compact) return;
          drag.setValue({ x: gesture.dx, y: gesture.dy });
        },
        onPanResponderRelease: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
          finishDrag(gesture.dx, gesture.dy),
        onPanResponderTerminate: (
          _event: GestureResponderEvent,
          gesture: PanResponderGestureState,
        ) => finishDrag(gesture.dx, gesture.dy),
        onPanResponderTerminationRequest: () => false,
      }),
    [compact, drag, finishDrag, onDragStart, provider.providerId],
  );
  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      const action = event.nativeEvent.actionName;
      if (action === "moveEarlier") {
        if (canMoveUp) onMove(provider.providerId, -1);
        return;
      }
      if (action === "moveLater") {
        if (canMoveDown) onMove(provider.providerId, 1);
        return;
      }
      if (typeof cardWidth !== "number") return;
      const step = action === "narrower" ? -CARD_RESIZE_STEP : CARD_RESIZE_STEP;
      onResize(provider.providerId, cardWidth + step, cardHeight);
    },
    [canMoveDown, canMoveUp, cardHeight, cardWidth, onMove, onResize, provider.providerId],
  );
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => !compact && draggingRef.current,
        onMoveShouldSetPanResponderCapture: () => !compact && draggingRef.current,
        onPanResponderGrant: () => {
          drag.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: (_event, gesture) => {
          if (compact || !draggingRef.current) return;
          drag.setValue({ x: gesture.dx, y: gesture.dy });
        },
        onPanResponderRelease: (_event, gesture) => {
          if (!compact && draggingRef.current) finishDrag(gesture.dx, gesture.dy);
        },
        onPanResponderTerminate: (_event, gesture) => {
          if (!compact && draggingRef.current) finishDrag(gesture.dx, gesture.dy);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [compact, drag, finishDrag],
  );
  const createResizeResponder = useCallback(
    (axes: "width" | "height" | "both") =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !compact && typeof cardWidthRef.current === "number",
        onMoveShouldSetPanResponder: () => !compact && typeof cardWidthRef.current === "number",
        onPanResponderGrant: () => {
          if (compact || typeof cardWidthRef.current !== "number") return;
          resizeOriginRef.current = {
            width: cardWidthRef.current,
            height: cardHeightRef.current ?? measuredCardRef.current.height,
          };
          onResizeStartRef.current(provider.providerId);
        },
        onPanResponderMove: (_event, gesture) => {
          if (compact) return;
          const width =
            axes === "height"
              ? resizeOriginRef.current.width
              : resizeOriginRef.current.width + gesture.dx;
          const height =
            axes === "width"
              ? resizeOriginRef.current.height
              : resizeOriginRef.current.height + gesture.dy;
          onResizeRef.current(provider.providerId, width, height);
        },
        onPanResponderRelease: () => onResizeEndRef.current(),
        onPanResponderTerminate: () => onResizeEndRef.current(),
        onPanResponderTerminationRequest: () => false,
      }),
    [compact, provider.providerId],
  );
  const resizeWidthResponder = useMemo(
    () => createResizeResponder("width"),
    [createResizeResponder],
  );
  const resizeHeightResponder = useMemo(
    () => createResizeResponder("height"),
    [createResizeResponder],
  );
  const resizeCornerResponder = useMemo(
    () => createResizeResponder("both"),
    [createResizeResponder],
  );
  const measureCard = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    measuredCardRef.current = { width, height };
    // Only a column-boundary crossing can change the layout, so the state
    // settles instead of re-rendering on every sub-pixel of a resize drag.
    setMeasuredWidth((current) => (Math.abs(current - width) < 1 ? current : width));
  }, []);
  const setDragHandleTooltip = useCallback(
    (node: unknown) => {
      setTooltipTitle(node, `Drag to reorder ${provider.label}`);
    },
    [provider.label],
  );
  const updated = formatUpdatedLabel(provider.fetchedAt, now, isShowingStaleReadings(provider));
  const columns = autoColumns(
    typeof cardWidth === "number" ? cardWidth : measuredWidth,
    compact ? 12 : 16,
  );
  const animatedStyle = useMemo(() => ({ transform: drag.getTranslateTransform() }), [drag]);
  return (
    <Animated.View
      {...(compact ? EMPTY_PAN_HANDLERS : panResponder.panHandlers)}
      onLayout={measureCard}
      style={[
        styles.cardSlot,
        { width: cardWidth, height: cardHeight },
        dragging ? styles.draggingCard : null,
        resizing ? styles.resizingCard : null,
        dragging ? animatedStyle : null,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${provider.label}. Long press to reorder, or drag an edge to resize.`}
        tooltip={`Reorder or resize ${provider.label}`}
        accessibilityActions={CARD_ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        delayLongPress={350}
        onLongPress={compact ? undefined : startDrag}
        style={[styles.card, cardHeight === undefined ? null : styles.sizedCard]}
      >
        <ScrollView
          nestedScrollEnabled
          scrollEnabled={cardHeight !== undefined}
          style={cardHeight === undefined ? null : styles.cardScroller}
          contentContainerStyle={styles.cardContent}
        >
          <View style={styles.cardHeader}>
            <View style={styles.identity}>
              <ProviderMark
                icon={provider.icon}
                fallbackText={fallbackMonogram(provider.label)}
                theme={theme}
                compact={compact}
                styles={styles}
              />
              <StatusDot
                status={provider.status}
                hasNotice={provider.notice !== null}
                styles={styles}
              />
              <Text style={styles.providerLabel}>{provider.label}</Text>
              {provider.unverified ? <Pill label="Unverified" styles={styles} /> : null}
            </View>
            <View style={styles.moveControls}>
              {updated === null ? null : <Text style={styles.hint}>{updated}</Text>}
              <View
                {...(compact ? EMPTY_PAN_HANDLERS : dragGripResponder.panHandlers)}
                style={styles.dragHandle}
                accessibilityRole="button"
                accessibilityLabel={`Drag to reorder ${provider.label}`}
                hitSlop={DRAG_HANDLE_HIT_SLOP}
                ref={setDragHandleTooltip}
              >
                <Icon name="GripVertical" size={14} color={theme.colors.foregroundMuted} />
              </View>
            </View>
          </View>
          {provider.notice === null ? null : <Text style={styles.notice}>{provider.notice}</Text>}
          <ProviderBody
            provider={provider}
            styles={styles}
            theme={theme}
            compact={compact}
            now={now}
            display={display}
            columns={columns}
          />
        </ScrollView>
        {compact ? null : (
          <>
            <View
              {...resizeWidthResponder.panHandlers}
              accessibilityRole="adjustable"
              accessibilityLabel={`Drag the right edge to resize ${provider.label}`}
              style={styles.resizeEdgeRight}
            />
            <View
              {...resizeHeightResponder.panHandlers}
              accessibilityRole="adjustable"
              accessibilityLabel={`Drag the bottom edge to resize ${provider.label}`}
              style={styles.resizeEdgeBottom}
            />
            <View
              {...resizeCornerResponder.panHandlers}
              accessibilityRole="adjustable"
              accessibilityLabel={`Drag the corner to resize ${provider.label}`}
              style={styles.resizeCorner}
            />
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

interface UsageProviderGridProps extends Omit<UsageRowChrome, "display"> {
  snapshot: UsageSnapshot | undefined;
  errorMessage: string | null;
  isPending: boolean;
  cardWidth: number | "100%";
  cardSizes: ReadonlyMap<string, ProviderCardSize>;
  draggingId: string | null;
  resizingId: string | null;
  onDragStart(providerId: string): void;
  onDragEnd(providerId: string, dx: number, dy: number): void;
  onMove(providerId: string, direction: -1 | 1): void;
  onResizeStart(providerId: string): void;
  onResize(providerId: string, width: number, height?: number): void;
  onResizeEnd(): void;
  onLayout(event: LayoutChangeEvent): void;
}

function providerOrder(left: UsageProviderSnapshot, right: UsageProviderSnapshot): number {
  const leftOrder = left.display.order;
  const rightOrder = right.display.order;
  if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftOrder !== undefined && rightOrder === undefined) return -1;
  if (leftOrder === undefined && rightOrder !== undefined) return 1;
  return left.providerId.localeCompare(right.providerId);
}

function orderedProviders(providers: readonly UsageProviderSnapshot[]): UsageProviderSnapshot[] {
  return [...providers].sort(providerOrder);
}

function UsageProviderGrid({
  snapshot,
  errorMessage,
  isPending,
  cardWidth,
  cardSizes,
  draggingId,
  resizingId,
  styles,
  theme,
  compact,
  now,
  onDragStart,
  onDragEnd,
  onMove,
  onResizeStart,
  onResize,
  onResizeEnd,
  onLayout,
}: UsageProviderGridProps) {
  if (isPending) {
    return <Text style={styles.hint}>Loading usage…</Text>;
  }
  if (errorMessage !== null) {
    return (
      <View style={styles.rows}>
        <Text style={styles.error}>{errorMessage}</Text>
        {snapshot === undefined ? null : (
          <Text style={styles.hint}>{`Config: ${snapshot.configPath}`}</Text>
        )}
      </View>
    );
  }
  if (snapshot === undefined) {
    return <Text style={styles.hint}>No usage snapshot yet.</Text>;
  }
  if (snapshot.providers.length === 0) {
    return (
      <View style={styles.rows}>
        <Text style={styles.emptyTitle}>No usage providers configured</Text>
        <Text
          style={styles.hint}
        >{`Add a "claude" or "codex" entry to ${snapshot.configPath} to track quota, balance and rate limits here.`}</Text>
      </View>
    );
  }
  const providers = orderedProviders(snapshot.providers);
  return (
    <View onLayout={onLayout} style={styles.cardGrid}>
      {providers.map((provider, index) => (
        <ProviderCard
          key={provider.providerId}
          provider={provider}
          cardWidth={cardSizes.get(provider.providerId)?.width ?? cardWidth}
          cardHeight={cardSizes.get(provider.providerId)?.height}
          dragging={draggingId === provider.providerId}
          resizing={resizingId === provider.providerId}
          canMoveUp={index > 0}
          canMoveDown={index < providers.length - 1}
          styles={styles}
          theme={theme}
          compact={compact}
          now={now}
          display={provider.display}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMove={onMove}
          onResizeStart={onResizeStart}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      ))}
    </View>
  );
}

/**
 * Relative labels are this surface's only staleness signal, and a provider can
 * go fifteen minutes between fetches, so the clock has to advance on its own
 * rather than ride whatever else happens to re-render. A minute is finer than
 * anything these helpers print.
 */
function useTickingClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

function snapshotWithDisplays(
  snapshot: UsageSnapshot | undefined,
  commits: readonly UsageDisplayCommit[],
): UsageSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  const displays = new Map(commits.map((commit) => [commit.providerId, commit.display]));
  const providers = snapshot.providers.map((provider) => {
    const display = displays.get(provider.providerId);
    return display === undefined ? provider : { ...provider, display };
  });
  return { ...snapshot, providers: orderedProviders(providers) };
}

function snapshotWithDisplayOverrides(
  snapshot: UsageSnapshot,
  overrides: ReadonlyMap<string, UsageDisplay>,
): UsageSnapshot {
  const providers = snapshot.providers.map((provider) => {
    const display = overrides.get(provider.providerId);
    return display === undefined ? provider : { ...provider, display };
  });
  return { ...snapshot, providers: orderedProviders(providers) };
}

function reorderCommits(
  providers: readonly UsageProviderSnapshot[],
  providerId: string,
  targetIndex: number,
): UsageDisplayCommit[] {
  const ordered = orderedProviders(providers);
  const fromIndex = ordered.findIndex((provider) => provider.providerId === providerId);
  if (fromIndex < 0) return [];
  const destination = Math.max(0, Math.min(ordered.length - 1, targetIndex));
  if (destination === fromIndex) return [];
  const next = [...ordered];
  const removed = next.splice(fromIndex, 1)[0];
  if (removed === undefined) return [];
  next.splice(destination, 0, removed);
  return next.map((provider, order) => ({
    providerId: provider.providerId,
    display: { ...provider.display, order },
    previous: provider.display,
  }));
}

function UsageLimitsBody({ theme, host, layout }: PluginSurfaceProps) {
  const compact = layout.compact;
  const readLimits = useRpc(readUsageLimits);
  const readConfig = useRpc(readUsageConfig);
  const writeProvider = useRpc(writeUsageProvider);
  const queryClient = useQueryClient();
  const displayOverrides = useRef(new Map<string, UsageDisplay>());
  const [view, setView] = useState<"usage" | "history" | "settings">("usage");
  const [containerWidth, setContainerWidth] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [cardSizes, setCardSizes] = useState<ReadonlyMap<string, ProviderCardSize>>(
    () => new Map(),
  );
  const [displayError, setDisplayError] = useState<string | null>(null);
  const readSnapshot = useCallback(
    async (refresh: boolean) => {
      const snapshot = await readLimits({ refresh });
      return snapshotWithDisplayOverrides(snapshot, displayOverrides.current);
    },
    [readLimits],
  );
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: USAGE_LIMITS_QUERY_KEY,
    queryFn: () => readSnapshot(false),
    refetchInterval: LIMITS_POLL_MS,
    refetchOnWindowFocus: Platform.OS === "web",
  });

  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }
    const subscription = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "active") {
        void refetch();
      }
    });
    return () => subscription.remove();
  }, [refetch]);
  const {
    mutate: refreshUsage,
    isPending: isRefreshing,
    error: refreshError,
  } = useMutation({
    mutationFn: () => readSnapshot(true),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
    },
  });
  const displayMutation = useMutation({
    mutationFn: async (commits: readonly UsageDisplayCommit[]) => {
      let config: UsageConfigState = await readConfig({});
      for (const commit of commits) {
        const entry = config.providers[commit.providerId];
        if (entry === undefined) {
          throw new Error(`Usage provider "${commit.providerId}" is no longer configured.`);
        }
        config = await writeProvider({
          id: commit.providerId,
          entry: { ...entry, display: commit.display },
          secrets: {},
        });
      }
      return config;
    },
    onSuccess: (config) => {
      queryClient.setQueryData(USAGE_CONFIG_QUERY_KEY, config);
      setDisplayError(null);
    },
    onError: (writeError, commits) => {
      for (const commit of commits) {
        displayOverrides.current.set(commit.providerId, commit.previous);
      }
      queryClient.setQueryData<UsageSnapshot | undefined>(USAGE_LIMITS_QUERY_KEY, (snapshot) =>
        snapshotWithDisplays(
          snapshot,
          commits.map((commit) => ({ ...commit, display: commit.previous })),
        ),
      );
      setDisplayError(writeError.message);
    },
  });

  const styles = useMemo<UsageStyles>(() => {
    const padding = layout.compact ? 12 : 16;
    const gap = layout.compact ? 8 : 12;
    const fontSize = layout.compact ? 13 : 14;
    const smallFontSize = layout.compact ? 11 : 12;
    const detailFontSize = layout.compact ? 10 : 11;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap,
        paddingHorizontal: padding,
        paddingVertical: padding,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
      tabs: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 4,
        paddingHorizontal: padding,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      tab: {
        paddingHorizontal: layout.compact ? 8 : 10,
        paddingVertical: layout.compact ? 8 : 10,
        borderBottomWidth: 2,
        borderBottomColor: theme.colors.surface0,
      },
      tabSelected: { borderBottomColor: theme.colors.accent },
      tabText: { color: theme.colors.foregroundMuted, fontSize: smallFontSize, fontWeight: "500" },
      tabTextSelected: {
        color: theme.colors.foreground,
        fontSize: smallFontSize,
        fontWeight: "600",
      },
      back: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 16 : 18,
        fontWeight: "600",
      },
      refresh: {
        padding: layout.compact ? 6 : 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      refreshBusy: { opacity: 0.5 },
      body: { padding, gap },
      cardGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap,
      },
      cardSlot: {},
      draggingCard: { opacity: 0.9, zIndex: 2 },
      resizingCard: { zIndex: 1 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
      },
      sizedCard: { height: "100%" },
      cardContent: { padding, gap },
      cardScroller: { flex: 1 },
      cardHeader: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap,
      },
      identity: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        flexGrow: 1,
        flexShrink: 1,
      },
      moveControls: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 4,
        maxWidth: "100%",
      },
      dragHandle: {
        padding: layout.compact ? 4 : 5,
        borderRadius: 6,
        justifyContent: "center",
        alignItems: "center",
      },
      iconButton: {
        padding: layout.compact ? 4 : 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      resizeEdgeRight: {
        position: "absolute",
        top: 0,
        bottom: RESIZE_EDGE_THICKNESS,
        right: 0,
        width: RESIZE_EDGE_THICKNESS,
      },
      resizeEdgeBottom: {
        position: "absolute",
        left: 0,
        right: RESIZE_EDGE_THICKNESS,
        bottom: 0,
        height: RESIZE_EDGE_THICKNESS,
      },
      resizeCorner: {
        position: "absolute",
        right: 2,
        bottom: 2,
        width: RESIZE_CORNER_SIZE,
        height: RESIZE_CORNER_SIZE,
        borderBottomRightRadius: 9,
        borderRightWidth: 2,
        borderBottomWidth: 2,
        borderColor: theme.colors.border,
      },
      providerMark: {
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      },
      providerImage: { borderRadius: layout.compact ? 6 : 7 },
      providerMonogram: {
        alignItems: "center",
        justifyContent: "center",
        borderRadius: layout.compact ? 6 : 7,
        flexShrink: 0,
      },
      providerMonogramText: {
        color: theme.colors.accentForeground,
        fontSize: layout.compact ? 10 : 12,
        fontWeight: "700",
        textAlign: "center",
      },
      providerLabel: {
        color: theme.colors.foreground,
        fontSize,
        fontWeight: "600",
        flexShrink: 1,
      },
      description: {
        color: theme.colors.foregroundMuted,
        fontSize: smallFontSize,
        lineHeight: smallFontSize + 5,
      },
      dotOk: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.statusSuccess },
      dotWarning: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.statusWarning,
      },
      dotDanger: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.statusDanger,
      },
      pill: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      pillText: { color: theme.colors.foregroundMuted, fontSize: smallFontSize },
      group: { gap },
      groupLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: smallFontSize,
        fontWeight: "600",
      },
      readingGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        marginHorizontal: -(gap / 2),
        rowGap: gap,
      },
      readingCell1: { flexBasis: "100%", maxWidth: "100%", paddingHorizontal: gap / 2 },
      readingCell2: { flexBasis: "50%", maxWidth: "50%", paddingHorizontal: gap / 2 },
      readingCell3: { flexBasis: "33.333%", maxWidth: "33.333%", paddingHorizontal: gap / 2 },
      readingCell4: { flexBasis: "25%", maxWidth: "25%", paddingHorizontal: gap / 2 },
      rows: { gap },
      row: { gap: 4 },
      rowHeader: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      },
      rowTitle: {
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        flexGrow: 1,
        flexShrink: 1,
      },
      rowLabel: { color: theme.colors.foreground, fontSize, flexShrink: 1 },
      qualifier: { color: theme.colors.foregroundMuted, fontSize: smallFontSize },
      value: { color: theme.colors.foregroundMuted, fontSize: smallFontSize, textAlign: "right" },
      trailing: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: smallFontSize,
        lineHeight: smallFontSize + 4,
      },
      error: { color: theme.colors.statusDanger, fontSize: smallFontSize },
      emptyTitle: { color: theme.colors.foreground, fontSize },
      notice: {
        color: theme.colors.statusWarning,
        fontSize: smallFontSize,
        lineHeight: smallFontSize + 5,
      },
      detail: {
        color: theme.colors.foregroundMuted,
        fontSize: detailFontSize,
        lineHeight: detailFontSize + 4,
      },
    };
  }, [theme, layout.compact]);

  const isBusy = isFetching || isRefreshing;
  const handleRefresh = useCallback(() => {
    refreshUsage();
  }, [refreshUsage]);

  const queryError = error ?? refreshError;
  const now = useTickingClock();
  const rateLimited = data?.providers.some((provider) => provider.notice !== null) ?? false;
  const gap = compact ? 8 : 12;
  const columnCount =
    compact || containerWidth <= 0
      ? 1
      : Math.max(1, Math.floor((containerWidth + gap) / (MIN_CARD_WIDTH + gap)));
  const cardWidth =
    containerWidth <= 0 ? "100%" : (containerWidth - gap * (columnCount - 1)) / columnCount;
  const visibleCardSizes = useMemo<ReadonlyMap<string, ProviderCardSize>>(() => {
    if (containerWidth <= 0) return cardSizes;
    const minimumWidth = Math.min(MIN_RESIZED_CARD_WIDTH, containerWidth);
    const visible = new Map<string, ProviderCardSize>();
    for (const [providerId, size] of cardSizes) {
      visible.set(providerId, {
        width: Math.max(minimumWidth, Math.min(containerWidth, size.width)),
        height: size.height,
      });
    }
    return visible;
  }, [cardSizes, containerWidth]);
  const commitDisplays = useCallback(
    (commits: readonly UsageDisplayCommit[]) => {
      if (commits.length === 0) return;
      setDisplayError(null);
      for (const commit of commits) {
        displayOverrides.current.set(commit.providerId, commit.display);
      }
      queryClient.setQueryData<UsageSnapshot | undefined>(USAGE_LIMITS_QUERY_KEY, (snapshot) =>
        snapshotWithDisplays(snapshot, commits),
      );
      displayMutation.mutate(commits);
    },
    [displayMutation, queryClient],
  );
  const reorder = useCallback(
    (providerId: string, targetIndex: number) => {
      if (data === undefined) return;
      commitDisplays(reorderCommits(data.providers, providerId, targetIndex));
    },
    [commitDisplays, data],
  );
  const moveProvider = useCallback(
    (providerId: string, direction: -1 | 1) => {
      if (data === undefined) return;
      const providers = orderedProviders(data.providers);
      const index = providers.findIndex((provider) => provider.providerId === providerId);
      if (index < 0) return;
      reorder(providerId, index + direction);
    },
    [data, reorder],
  );
  const startDrag = useCallback((providerId: string) => setDraggingId(providerId), []);
  const startResize = useCallback((providerId: string) => setResizingId(providerId), []);
  const resizeProvider = useCallback(
    (providerId: string, width: number, height?: number) => {
      if (containerWidth <= 0) return;
      const minimumWidth = Math.min(MIN_RESIZED_CARD_WIDTH, containerWidth);
      const nextWidth = Math.max(minimumWidth, Math.min(containerWidth, width));
      setCardSizes((current) => {
        const previous = current.get(providerId);
        const nextHeight =
          height === undefined
            ? previous?.height
            : Math.max(MIN_RESIZED_CARD_HEIGHT, Math.min(MAX_RESIZED_CARD_HEIGHT, height));
        if (previous?.width === nextWidth && previous.height === nextHeight) return current;
        const next = new Map(current);
        next.set(providerId, { width: nextWidth, height: nextHeight });
        return next;
      });
    },
    [containerWidth],
  );
  const endResize = useCallback(() => setResizingId(null), []);
  const endDrag = useCallback(
    (providerId: string, dx: number, dy: number) => {
      setDraggingId(null);
      if (data === undefined) return;
      const providers = orderedProviders(data.providers);
      const index = providers.findIndex((provider) => provider.providerId === providerId);
      if (index < 0 || cardWidth === "100%") return;
      const currentColumn = index % columnCount;
      const currentRow = Math.floor(index / columnCount);
      const columnShift = Math.round(dx / (cardWidth + gap));
      const rowShift = Math.round(dy / DRAG_ROW_STEP);
      const targetColumn = Math.max(0, Math.min(columnCount - 1, currentColumn + columnShift));
      const targetRow = Math.max(0, currentRow + rowShift);
      const targetIndex = Math.max(
        0,
        Math.min(providers.length - 1, targetRow * columnCount + targetColumn),
      );
      reorder(providerId, targetIndex);
    },
    [cardWidth, columnCount, data, gap, reorder],
  );
  const measureGrid = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((currentWidth) =>
      Math.abs(currentWidth - nextWidth) < 1 ? currentWidth : nextWidth,
    );
  }, []);
  const showSettings = useCallback(() => setView("settings"), []);
  const showUsage = useCallback(() => setView("usage"), []);
  const showHistory = useCallback(() => setView("history"), []);

  if (view === "settings") {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to usage"
            tooltip="Back to usage"
            hitSlop={BACK_BUTTON_HIT_SLOP}
            onPress={showUsage}
            style={styles.back}
          >
            <Icon name="ChevronLeft" size={compact ? 15 : 17} color={theme.colors.accent} />
            <Text style={styles.headerTitle}>Usage provider settings</Text>
          </Pressable>
        </View>
        <UsageSettingsBody theme={theme} host={host} layout={layout} showHeader={false} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {view === "history" ? "Usage history" : "Usage limits"}
        </Text>
        {view === "usage" ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={refreshLabel(isBusy, rateLimited)}
              tooltip={refreshLabel(isBusy, rateLimited)}
              accessibilityState={isBusy ? REFRESH_BUSY_STATE : REFRESH_IDLE_STATE}
              disabled={isBusy}
              hitSlop={ICON_BUTTON_HIT_SLOP}
              onPress={handleRefresh}
              style={[styles.refresh, isBusy ? styles.refreshBusy : null]}
            >
              <Icon
                name="RefreshCw"
                size={compact ? 14 : 16}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open usage provider settings"
              tooltip="Open usage provider settings"
              hitSlop={ICON_BUTTON_HIT_SLOP}
              onPress={showSettings}
              style={styles.refresh}
            >
              <Icon
                name="Settings2"
                size={compact ? 14 : 16}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        ) : null}
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Show current usage"
          tooltip="Show current usage"
          accessibilityState={view === "usage" ? DISPLAY_SELECTED_STATE : DISPLAY_UNSELECTED_STATE}
          hitSlop={TAB_HIT_SLOP}
          onPress={showUsage}
          style={[styles.tab, view === "usage" ? styles.tabSelected : null]}
        >
          <Text style={view === "usage" ? styles.tabTextSelected : styles.tabText}>Usage</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Show usage history"
          tooltip="Show usage history"
          accessibilityState={
            view === "history" ? DISPLAY_SELECTED_STATE : DISPLAY_UNSELECTED_STATE
          }
          hitSlop={TAB_HIT_SLOP}
          onPress={showHistory}
          style={[styles.tab, view === "history" ? styles.tabSelected : null]}
        >
          <Text style={view === "history" ? styles.tabTextSelected : styles.tabText}>History</Text>
        </Pressable>
      </View>
      {view === "history" ? (
        <UsageHistorySurface theme={theme} host={host} layout={layout} />
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {displayError === null ? null : <Text style={styles.error}>{displayError}</Text>}
          <UsageProviderGrid
            snapshot={data}
            errorMessage={queryError === null ? null : queryError.message}
            isPending={isPending}
            styles={styles}
            theme={theme}
            compact={compact}
            now={now}
            cardWidth={cardWidth}
            cardSizes={visibleCardSizes}
            draggingId={draggingId}
            resizingId={resizingId}
            onDragStart={startDrag}
            onDragEnd={endDrag}
            onMove={moveProvider}
            onResizeStart={startResize}
            onResize={resizeProvider}
            onResizeEnd={endResize}
            onLayout={measureGrid}
          />
        </ScrollView>
      )}
    </View>
  );
}

export function UsageLimitsSurface(props: PluginSurfaceProps) {
  return <UsageLimitsBody theme={props.theme} host={props.host} layout={props.layout} />;
}

export function UsageLimitsPanel(props: PluginWorkspacePanelProps) {
  return <UsageLimitsBody theme={props.theme} host={props.host} layout={props.layout} />;
}
