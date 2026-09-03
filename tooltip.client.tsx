import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type PressableProps,
  type PressableStateCallbackType,
  type TextStyle,
  type ViewStyle,
} from "react-native";

type TooltipPressableProps = PressableProps & {
  readonly tooltip: string;
};

interface AttributeNode {
  setAttribute(name: string, value: string): void;
}

function supportsSetAttribute(node: unknown): node is AttributeNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "setAttribute" in node &&
    typeof (node as AttributeNode).setAttribute === "function"
  );
}

interface HoverTarget extends AttributeNode {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function isHoverTarget(node: unknown): node is HoverTarget {
  return (
    supportsSetAttribute(node) &&
    typeof (node as HoverTarget).addEventListener === "function" &&
    typeof (node as HoverTarget).removeEventListener === "function"
  );
}

/**
 * Sets the DOM `title` attribute so the platform tooltip and screen readers see
 * the label. react-native-web drops a `title` prop, so the node is touched
 * directly; native hosts have no `setAttribute` and are left alone.
 */
export function setTooltipTitle(node: unknown, tooltip: string): void {
  if (supportsSetAttribute(node)) {
    node.setAttribute("title", tooltip);
  }
}

/**
 * The bubble is an absolutely positioned child, so it never takes part in the
 * button's layout. It hangs below the trigger because panels clip at their top
 * edge far more often than at the bottom. An absolute box shrink-wraps to its
 * containing block, which would squeeze the label into an icon-width column, so
 * on web it sizes to its content instead and only wraps at `maxWidth`.
 */
const BUBBLE: ViewStyle = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 4,
  maxWidth: 260,
  paddingHorizontal: 8,
  paddingVertical: 4,
  borderRadius: 6,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.14)",
  backgroundColor: "rgba(28,28,30,0.96)",
  zIndex: 1000,
  ...(Platform.OS === "web" ? ({ width: "max-content" } as unknown as ViewStyle) : null),
};

const BUBBLE_TEXT: TextStyle = {
  color: "#f5f5f7",
  fontSize: 11,
  lineHeight: 14,
};

/**
 * Hover is tracked with DOM listeners rather than `onHoverIn`/`onHoverOut`
 * because react-native-web suppresses those callbacks while a Pressable is
 * disabled, and the busy states ("Refreshing tasks", "Stopping <agent>") are
 * exactly the ones a hover label needs to explain.
 */
export function TooltipPressable({
  tooltip,
  children,
  ...props
}: TooltipPressableProps): ReactElement {
  const [hovered, setHovered] = useState(false);

  const attach = useCallback(
    (node: unknown) => {
      setTooltipTitle(node, tooltip);
      if (!isHoverTarget(node)) return undefined;
      const enter = () => setHovered(true);
      const leave = () => setHovered(false);
      node.addEventListener("mouseenter", enter);
      node.addEventListener("mouseleave", leave);
      return () => {
        node.removeEventListener("mouseenter", enter);
        node.removeEventListener("mouseleave", leave);
        setHovered(false);
      };
    },
    [tooltip],
  );

  const bubble = hovered ? (
    <View key="tooltip" pointerEvents="none" style={BUBBLE}>
      <Text numberOfLines={2} style={BUBBLE_TEXT}>
        {tooltip}
      </Text>
    </View>
  ) : null;

  const content =
    typeof children === "function"
      ? (state: PressableStateCallbackType): ReactNode => (
          <>
            {children(state)}
            {bubble}
          </>
        )
      : ((
          <>
            {children}
            {bubble}
          </>
        ) as ReactNode);

  return (
    <Pressable {...props} ref={attach}>
      {content}
    </Pressable>
  );
}
