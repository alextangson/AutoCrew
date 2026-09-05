/**
 * 设置 · 模型页的**端点表**（P2 spec §5.2 第一段）——名称 / 地址 / Key / 模型清单 /
 * 状态点 / 测试 / 删除。
 *
 * 两条纪律：
 * 1. **状态点与横幅同源**（`engine:health`）：设置页说「通」而顶栏说「坏」是最坏的情形，
 *    所以这里一个字都不自己算，只画 `providerDot` 的结论。
 * 2. **删除要说得出谁在用**。被主端点 / 备用 / 任一岗位引用的端点删不掉，
 *    拒绝时把引用者列出来——「删不了」而不说为什么，等于让人去猜。
 */
import { Field } from "./settings-kit";
import { providerDot, referrersOf, type EnginePointers, type HealthProvider, type ProviderRow } from "./engine-lib";

export type TestState =
  | { status: "running" }
  | { status: "ok"; ms: number; model: string }
  | { status: "fail"; error: string };

export function TestButton(props: { label?: string; state?: TestState; disabled?: boolean; title?: string; onRun: () => void }) {
  const running = props.state?.status === "running";
  return (
    <button
      className="set-test-btn"
      // 测试中禁重复点：一次探针就是一次真实调用，连点等于连着烧上游额度
      disabled={running || props.disabled}
      {...(props.title ? { title: props.title } : {})}
      onClick={props.onRun}
    >
      {running ? "测试中…" : (props.label ?? "测试")}
    </button>
  );
}

export function TestLine(props: { label?: string; state?: TestState }) {
  const s = props.state;
  if (!s || s.status === "running") return null;
  const prefix = props.label ? `${props.label}：` : "";
  if (s.status === "fail") return <p className="mono set-test-fail">✗ {prefix}{s.error}</p>;
  return <p className="mono set-test-ok">✓ {prefix}通了 · {s.ms}ms · {s.model}</p>;
}

/** 状态点：未测 / 通 · 1.5s / 坏 · 原因。没有健康记录 = 未测，绝不画成坏 */
export function HealthDot(props: { provider?: HealthProvider | undefined }) {
  const dot = providerDot(props.provider ?? { probe: null, live: null });
  return (
    <span className={`mono engine-dot engine-dot-${dot.tone}`} title={dot.title}>
      {dot.text}
    </span>
  );
}

export function ProviderTable(props: {
  rows: ProviderRow[];
  health: HealthProvider[];
  pointers: EnginePointers;
  tests: Record<string, TestState>;
  onPatch: (key: string, patch: Partial<ProviderRow>) => void;
  onAdd: () => void;
  onDelete: (row: ProviderRow) => void;
  onTest: (slot: string, providerId: string, model: string) => void;
}) {
  return (
    <>
      <p className="mono muted set-sub-head">端点表 · 密钥按端点只存一份，主端点 / 备用 / 岗位全部指过来</p>
      {props.rows.length === 0 && <p className="muted">端点表是空的——加一条，填地址、Key 与至少一个模型名。</p>}
      {props.rows.map((p) => {
        const slot = p.savedModels[0] ? `p:${p.id}:${p.savedModels[0]}` : "";
        const used = p.id ? referrersOf(p.id, props.pointers) : [];
        return (
          <div key={p.key} className="set-route set-provider">
            <div className="set-route-head">
              <span className="set-route-name">{p.name.trim() || "未命名端点"}</span>
              <HealthDot provider={props.health.find((h) => h.id === p.id)} />
              <span className="mono muted set-route-now">{p.id || "保存后分配 id"}</span>
              <button onClick={() => props.onDelete(p)}>删除</button>
            </div>
            {used.length > 0 && <p className="muted set-route-note">正在被 {used.join("、")} 使用</p>}
            <Field label="名称" value={p.name} placeholder="如：DeepSeek 官方" onChange={(v) => props.onPatch(p.key, { name: v })} />
            <Field label="地址" value={p.baseUrl} placeholder="https://api.deepseek.com" onChange={(v) => props.onPatch(p.key, { baseUrl: v })} />
            <Field
              label="模型"
              value={p.models}
              placeholder="逗号分隔，如：deepseek-v4-pro, deepseek-v4-flash"
              onChange={(v) => props.onPatch(p.key, { models: v })}
            />
            <label className="set-field">
              <span className="mono muted">协议</span>
              <select value={p.protocol} onChange={(e) => props.onPatch(p.key, { protocol: e.target.value })}>
                <option value="">自动推断（按 key 前缀与域名）</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </label>
            <Field
              label="API Key"
              password
              value={p.apiKey}
              placeholder={p.apiKeySet ? "已配置，留空保持不变" : "必填"}
              onChange={(v) => props.onPatch(p.key, { apiKey: v })}
            />
            <div className="set-route-foot">
              <TestButton
                label={p.savedModels[0] ? `测 ${p.savedModels[0]}` : "测试"}
                state={props.tests[slot]}
                disabled={!slot}
                title={slot ? "用已保存的地址与 key 测第一个模型" : "先保存这个端点，才能测"}
                onRun={() => props.onTest(slot, p.id, p.savedModels[0] ?? "")}
              />
            </div>
            <TestLine state={props.tests[slot]} />
          </div>
        );
      })}
      <div className="set-save">
        <button onClick={props.onAdd}>＋添加端点</button>
      </div>
    </>
  );
}
