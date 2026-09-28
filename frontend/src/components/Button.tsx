import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary",
  secondary: "",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

/** 样张按钮：一屏区域最多一个 primary；卡片内用 size="sm"（28 高）。 */
export function btnClass(variant: ButtonVariant = "secondary", size: "md" | "sm" = "md", extra?: string): string {
  return [VARIANT_CLASS[variant], size === "sm" ? "btn-sm" : "", extra ?? ""].filter(Boolean).join(" ");
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "md" | "sm" }) {
  const { variant, size, className, type, ...rest } = props;
  return <button type={type ?? "button"} className={btnClass(variant, size, className)} {...rest} />;
}
