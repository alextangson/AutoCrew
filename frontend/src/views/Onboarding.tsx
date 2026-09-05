/**
 * 首次开机（P2 spec §5.1）——一张卡问完：端点 + Key +（可选）搜索 Key，
 * 按钮「测试并进入」当场发一次极小调用。
 *
 * 两条产品决定（§9 创始人已确认）：
 * 1. **探针不通也放人进去**。锁在门外的人修不了配置；进去之后顶栏横幅接着说这条线还坏着。
 * 2. **搜索 Key 同屏但明确可选**，且一句话说清不配会怎样——它不是必填项，
 *    但等到深调研点不动才知道要它，就太晚了。
 */
import { useState } from "react";
import { invoke } from "../transport";
import {
  ENDPOINT_PRESETS,
  applyPreset,
  initialForm,
  presetOf,
  runOnboardingSave,
  type EndpointKind,
  type OnboardingSaveResult,
} from "./onboarding-lib";

export function Onboarding(props: { onDone: () => void }) {
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardingSaveResult | null>(null);
  const preset = presetOf(form.kind);

  const submit = async () => {
    setBusy(true);
    const r = await runOnboardingSave(invoke, form);
    setResult(r);
    setBusy(false);
    if (r.engineSaved && !r.probeError) props.onDone();
  };

  return (
    <div className="onboard">
      <div className="onboard-card onboard-wide">
        <div className="onboard-brand serif">AutoCrew 编辑部</div>
        <p className="onboard-welcome muted">
          欢迎。跑通「调研 → 立意 → 写稿」只要一把模型钥匙——选一个端点，粘一把 Key，就能开工。
        </p>

        <div className="onboard-kinds">
          {ENDPOINT_PRESETS.map((p) => (
            <label key={p.kind} className={form.kind === p.kind ? "onboard-kind on" : "onboard-kind"}>
              <input
                type="radio"
                name="endpoint-kind"
                checked={form.kind === p.kind}
                onChange={() => setForm((f) => applyPreset(f, p.kind as EndpointKind))}
              />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
        <p className="onboard-hint mono muted">{preset.hint}</p>

        {preset.needsAddress && (
          <label className="dlg-field">
            <span className="mono muted">端点地址</span>
            <input
              type="text"
              value={form.baseUrl}
              placeholder="https://code.newcli.com/claude/ultra"
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
          </label>
        )}
        <label className="dlg-field">
          <span className="mono muted">API Key</span>
          <input
            type="password"
            value={form.apiKey}
            placeholder="粘贴端点给你的 key"
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
        </label>
        <div className="onboard-pair">
          <label className="dlg-field">
            <span className="mono muted">强模型</span>
            <input
              type="text"
              value={form.strong}
              placeholder="写稿、审稿用的那档"
              onChange={(e) => setForm((f) => ({ ...f, strong: e.target.value }))}
            />
          </label>
          <label className="dlg-field">
            <span className="mono muted">快模型</span>
            <input
              type="text"
              value={form.fast}
              placeholder="对话、打分用的那档"
              onChange={(e) => setForm((f) => ({ ...f, fast: e.target.value }))}
            />
          </label>
        </div>
        <p className="onboard-hint mono muted">协议（OpenAI / Anthropic）按 key 前缀与域名自动识别，不用选。</p>

        <div className="onboard-optional">
          <div className="mono muted">搜索 Key · 可选</div>
          <p className="muted">不填也能写，但深调研不可用、稿子不会补证据。之后在「设置 · 接入更多」里随时补。</p>
          <div className="onboard-pair">
            <label className="dlg-field">
              <span className="mono muted">来源</span>
              <select
                value={form.searchProvider}
                onChange={(e) => setForm((f) => ({ ...f, searchProvider: e.target.value as "bocha" | "tavily" }))}
              >
                <option value="bocha">博查 bocha（中文优先）</option>
                <option value="tavily">Tavily（英文圈）</option>
              </select>
            </label>
            <label className="dlg-field">
              <span className="mono muted">搜索 Key</span>
              <input
                type="password"
                value={form.searchKey}
                placeholder="留空跳过"
                onChange={(e) => setForm((f) => ({ ...f, searchKey: e.target.value }))}
              />
            </label>
          </div>
        </div>

        {result?.engineError && <p className="set-test-fail mono">✗ {result.engineError}</p>}
        {result?.probeError && <p className="set-test-fail mono">✗ {result.probeError}</p>}
        {result?.searchError && <p className="set-test-fail mono">✗ 搜索 Key 没保存成功：{result.searchError}（引擎已保存，不影响写稿）</p>}

        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "测试中…" : "测试并进入"}
        </button>
        {result?.probeError && (
          // 不锁门（§9 第 2 条）：进去之后顶栏横幅会一直说这条线还坏着
          <button className="onboard-skip" onClick={props.onDone}>
            先进去再说
          </button>
        )}
      </div>
    </div>
  );
}
