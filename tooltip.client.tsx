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
