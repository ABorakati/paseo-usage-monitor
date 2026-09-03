import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { View, type ViewStyle } from "react-native";

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Thresholds always follow consumption, even when the geometry shows what remains. */
export function usageTone(percentUsed: number, theme: PluginTheme): string {
  if (percentUsed > 90) {
    return theme.colors.statusDanger;
  }
  if (percentUsed >= 70) {
    return theme.colors.statusWarning;
  }
  return theme.colors.accent;
}

export interface UsageMeterProps {
  /** Raw percent consumed. It chooses the threshold tone and is never clamped for labels. */
  percentUsed: number;
  /** The value the geometry depicts. Omit when it is the same as consumption. */
  percentFilled?: number;
  /** 0-100 where even consumption would sit now, expressed in the same direction as the fill. */
  pacePercent: number | null;
  style?: "bar" | "ring";
  theme: PluginTheme;
  compact: boolean;
}

interface MeterStyles {
  barTrack: ViewStyle;
  ring: ViewStyle;
  ringLeftClip: ViewStyle;
  ringRightClip: ViewStyle;
  ringLeftArc: ViewStyle;
  ringRightArc: ViewStyle;
  ringCenter: ViewStyle;
  paceTick: ViewStyle;
}

function createStyles(theme: PluginTheme, compact: boolean, tone: string): MeterStyles {
  const barHeight = compact ? 4 : 6;
  const ringSize = compact ? 42 : 50;
  const ringStroke = compact ? 5 : 6;
  const arc: ViewStyle = {
    position: "absolute",
    top: 0,
    width: ringSize,
    height: ringSize,
    borderRadius: ringSize / 2,
    borderWidth: ringStroke,
    borderColor: theme.colors.surface2,
    borderTopColor: tone,
    borderRightColor: tone,
  };
  return {
    barTrack: {
      height: barHeight,
      borderRadius: barHeight / 2,
      backgroundColor: theme.colors.surface2,
      overflow: "hidden",
    },
    ring: {
      width: ringSize,
      height: ringSize,
      borderRadius: ringSize / 2,
      backgroundColor: theme.colors.surface2,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    ringLeftClip: {
      position: "absolute",
      left: 0,
      top: 0,
      width: ringSize / 2,
      height: ringSize,
      overflow: "hidden",
    },
    ringRightClip: {
      position: "absolute",
      right: 0,
      top: 0,
      width: ringSize / 2,
      height: ringSize,
      overflow: "hidden",
    },
    ringLeftArc: { ...arc, left: 0 },
    ringRightArc: { ...arc, right: 0 },
    ringCenter: {
      width: ringSize - ringStroke * 2,
      height: ringSize - ringStroke * 2,
      borderRadius: (ringSize - ringStroke * 2) / 2,
      backgroundColor: theme.colors.surface1,
    },
    paceTick: {
      position: "absolute",
      top: 0,
      left: ringSize / 2 - 1,
      width: 2,
      height: ringStroke + 1,
      backgroundColor: theme.colors.foregroundMuted,
    },
  };
}

export function UsageMeter({
  percentUsed,
  percentFilled = percentUsed,
  pacePercent,
  style = "bar",
  theme,
  compact,
}: UsageMeterProps) {
  const fillPercent = clampPercent(percentFilled);
  const pace = pacePercent === null ? null : clampPercent(pacePercent);
  const tone = usageTone(percentUsed, theme);
  const styles = useMemo(() => createStyles(theme, compact, tone), [theme, compact, tone]);
  const barFill = useMemo<ViewStyle>(
    () => ({
      height: compact ? 4 : 6,
      borderRadius: compact ? 2 : 3,
      backgroundColor: tone,
      width: `${fillPercent}%`,
    }),
    [compact, fillPercent, tone],
  );
  const barPace = useMemo<ViewStyle | null>(() => {
    if (pace === null) {
      return null;
    }
    return {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 2,
      marginLeft: -1,
      left: `${pace}%`,
      backgroundColor: theme.colors.foregroundMuted,
    };
  }, [pace, theme]);
  const firstHalf = Math.min(fillPercent, 50) * 3.6;
  const secondHalf = Math.max(fillPercent - 50, 0) * 3.6;
  const leftArc = useMemo<ViewStyle>(
    () => ({ transform: [{ rotate: `${secondHalf + 45}deg` }] }),
    [secondHalf],
  );
  const rightArc = useMemo<ViewStyle>(
    () => ({ transform: [{ rotate: `${firstHalf - 135}deg` }] }),
    [firstHalf],
  );
  const ringPace = useMemo<ViewStyle | null>(() => {
    if (pace === null) {
      return null;
    }
    const ringSize = compact ? 42 : 50;
    return {
      position: "absolute",
      width: ringSize,
      height: ringSize,
      transform: [{ rotate: `${pace * 3.6}deg` }],
    };
  }, [compact, pace]);

  if (style === "ring") {
    return (
      <View
        accessibilityLabel={`${percentFilled}% filled`}
        accessibilityRole="progressbar"
        style={styles.ring}
      >
        <View style={styles.ringRightClip}>
          <View style={[styles.ringRightArc, rightArc]} />
        </View>
        <View style={styles.ringLeftClip}>
          <View style={[styles.ringLeftArc, leftArc]} />
        </View>
        <View style={styles.ringCenter} />
        {ringPace === null ? null : (
          <View style={ringPace}>
            <View style={styles.paceTick} />
          </View>
        )}
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={`${percentFilled}% filled`}
      accessibilityRole="progressbar"
      style={styles.barTrack}
    >
      <View style={barFill} />
      {barPace === null ? null : <View style={barPace} />}
    </View>
  );
}
