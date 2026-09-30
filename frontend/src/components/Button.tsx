import type { ButtonHTMLAttributes } from "react";

/**
 * 全站只有三种按钮（review-inbox §4.2，创始人定）：
 * - primary：黑底白字、圆角 8、高 36；每个面板最多一个，文字写后果（「就用这版」）；
 * - secondary：白底细边，同尺寸；
 * - quiet：灰字，悬停才显底色。
 * 旧名 ghost = quiet，danger 只是 secondary 的旧名（不再有第四种样子）。不做图标方块、不做分段按钮条；
 * 条件不够时不放灰掉的按钮，在按钮位置写原因。
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "ghost" | "danger";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary",
  secondary: "",
  quiet: "btn-ghost",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

export function btnClass(variant: ButtonVariant = "secondary", size: "md" | "sm" = "md", extra?: string): string {
  return [VARIANT_CLASS[variant], size === "sm" ? "btn-sm" : "", extra ?? ""].filter(Boolean).join(" ");
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "md" | "sm" }) {
  const { variant, size, className, type, ...rest } = props;
  return <button type={type ?? "button"} className={btnClass(variant, size, className)} {...rest} />;
}
