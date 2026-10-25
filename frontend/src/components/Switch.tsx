/**
 * 开关 / 勾选框 / 单选：都是原生 <input> 换皮，键盘、读屏、表单行为不变。
 * Switch = 一项设置的开/关（role=switch）；Checkbox = 多选或清单里勾一项；Radio = 几选一。
 * 外层 label、文案、aria-label 由调用方给，这里只管样子（样式在 components.css）。
 */
import type { InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;
const cls = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

export function Switch({ className, ...rest }: Props) {
  return <input type="checkbox" role="switch" aria-checked={!!rest.checked} {...rest} className={cls("ui-switch", className)} />;
}

export function Checkbox({ className, ...rest }: Props) {
  return <input type="checkbox" {...rest} className={cls("ui-check", className)} />;
}

export function Radio({ className, ...rest }: Props) {
  return <input type="radio" {...rest} className={cls("ui-radio", className)} />;
}
