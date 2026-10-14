// Looks inside a React element tree without a browser: function components are called to get what they draw, and the buttons
// found are returned with their text and what a click would call. Static markup cannot show which handler a button has.

import { type ReactElement, type ReactNode, isValidElement } from "react";

export interface FoundButton {
  text: string;
  className: string;
  onClick: (() => void) | undefined;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

export function buttons(root: ReactNode): FoundButton[] {
  const found: FoundButton[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!isValidElement(node)) return;
    const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void; className?: string }>;
    if (typeof el.type === "function") return walk((el.type as (p: unknown) => ReactNode)(el.props));
    if (el.type === "button") found.push({ text: textOf(el.props.children).replace(/\s+/g, " ").trim(), className: el.props.className ?? "", onClick: el.props.onClick });
    walk(el.props.children);
  };
  walk(root);
  return found;
}
