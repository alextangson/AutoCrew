/**
 * 输入框下方一排（v1.1，学 ChatCut）：后端 · 模型 · 思考强度 · 权限模式。
 * 每段对话记自己的设置；轮次进行中改了，旁边提示「下一轮生效」（U1）。
 * 内置引擎只显示它原有的模型切换器（U13）；本机后端没上报清单的项显示「默认」且不可点（U2）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { confirmDialog, toast } from "../ui";
import { PickerButton } from "../picker";
import { backendHint, selectable, type BackendId, type BackendStatus, type RunningAgent } from "./backend-choice";
import { BYPASS_CONFIRM, choiceLabel, controlState, PERMISSION_LABEL, type ConvSettings, type PermissionMode } from "./conv-settings";

export function ComposeControls(props: {
  backends: BackendStatus[];
  error: string;
  running: RunningAgent | null;
  backend: BackendId;
  busy: boolean;
  settings: ConvSettings;
  onPickBackend: (id: string) => void;
  onChange: (next: ConvSettings) => void;
  /** 内置引擎自己的模型切换器（沿用现有） */
  builtinModel: ReactNode;
}) {
  const [nextTurnHint, setNextTurnHint] = useState(false);
  useEffect(() => { if (!props.busy) setNextTurnHint(false); }, [props.busy]);
  const current = props.backends.find((b) => b.id === props.backend);
  const change = async (patch: Partial<ConvSettings>) => {
    if (patch.permissionMode === "bypass" && props.settings.permissionMode !== "bypass") {
      const yes = await confirmDialog({ title: "切到「全部放行」？", body: BYPASS_CONFIRM, confirmLabel: "全部放行" });
      if (!yes) return;
    }
    props.onChange({ ...props.settings, ...patch });
    if (props.busy) setNextTurnHint(true);
  };
  return (
    <>
      {(props.backends.length > 0 || props.error) && (
        <PickerButton
          className="chat-model-picker chat-backend-picker"
          label={props.error ? "后端清单读不到" : current?.label ?? "内置引擎"}
          title={props.error || (props.running?.otherLibrary ? "后台 agent 仍在处理旧库" : "总编辑用哪个后端")}
          disabled={props.busy}
          placement="up"
          groups={[{ items: props.backends.map((b) => ({ id: b.id, label: b.label, hint: backendHint(b), disabled: !selectable(b) })) }]}
          value={props.backend}
          onPick={props.onPickBackend}
          error={props.error}
          footer={props.running?.otherLibrary ? "后台 agent 仍在处理旧库" : "对话中途换后端会新开一段对话；内置引擎只在你手动选时用"}
        />
      )}
      {props.backend === "builtin" ? props.builtinModel : (
        <>
          <SettingPicker label="模型" value={props.settings.model} state={controlState(props.backend, current?.models ?? [])} onPick={(v) => void change({ model: v })} />
          <SettingPicker label="思考强度" value={props.settings.effort} state={controlState(props.backend, current?.efforts ?? [])} onPick={(v) => void change({ effort: v })} />
          <PickerButton
            className="chat-model-picker"
            label={PERMISSION_LABEL[props.settings.permissionMode]}
            title="跑命令、改文件前要不要问你（发布、删除类业务审批任何一档都照样弹卡）"
            placement="up"
            groups={[{ items: (Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((m) => ({ id: m, label: PERMISSION_LABEL[m] })) }]}
            value={props.settings.permissionMode}
            onPick={(v) => void change({ permissionMode: v as PermissionMode })}
            footer="「本对话都允许」换对话或重启后回到每次问；发布、删除仍每次弹审批"
          />
        </>
      )}
      {nextTurnHint && <span className="muted mono chat-next-turn">下一轮生效</span>}
    </>
  );
}

function SettingPicker(props: { label: string; value: string; state: ReturnType<typeof controlState>; onPick: (v: string) => void }) {
  if (props.state.hidden) return null;
  return (
    <PickerButton
      className="chat-model-picker"
      label={`${props.label} ${choiceLabel(props.state.items, props.value)}`}
      title={props.state.disabled ? `${props.label}：适配器没上报可选项，用默认` : `这段对话的${props.label}（下一轮生效）`}
      disabled={props.state.disabled}
      placement="up"
      groups={[{ items: props.state.items.map((c) => ({ id: c.value, label: c.label })) }]}
      value={props.value}
      onPick={(v) => { if (!props.state.disabled) props.onPick(v); else toast("适配器没上报可选项"); }}
    />
  );
}
