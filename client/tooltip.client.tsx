import { useCallback, type ReactElement } from "react";
import { Pressable, type PressableProps } from "react-native";

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

/**
 * Sets the DOM `title` attribute and lets the browser draw the tooltip.
 * react-native-web drops a `title` prop, so the node is touched directly.
 * Native hosts have no `setAttribute`, so mobile shows no tooltip and relies on
 * the `accessibilityLabel` every call site already carries.
 */
export function setTooltipTitle(node: unknown, tooltip: string): void {
  if (supportsSetAttribute(node)) {
    node.setAttribute("title", tooltip);
  }
}

export function TooltipPressable({ tooltip, ...props }: TooltipPressableProps): ReactElement {
  const setTooltip = useCallback(
    (node: unknown) => {
      setTooltipTitle(node, tooltip);
    },
    [tooltip],
  );

  return <Pressable {...props} ref={setTooltip} />;
}
