import type React from "react";

export const Platform = {
  OS: "web" as const,
  select: <T>(obj: { web?: T; default?: T }): T | undefined => obj.web ?? obj.default,
};

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
};

export function View(_props: Record<string, unknown>): React.ReactElement | null {
  return null;
}

export function Text(_props: Record<string, unknown>): React.ReactElement | null {
  return null;
}

export function Pressable(_props: Record<string, unknown>): React.ReactElement | null {
  return null;
}

/** Opening a vendor's usage page is a side effect no unit test should perform. */
export const Linking = {
  openURL: async (_url: string): Promise<void> => {},
};

export type TextStyle = Record<string, unknown>;
export type ViewStyle = Record<string, unknown>;
export type LayoutChangeEvent = { nativeEvent: { layout: { width: number; height: number } } };
