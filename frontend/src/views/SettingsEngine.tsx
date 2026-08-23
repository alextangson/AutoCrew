/**
 * 设置 · 引擎与模型路由。
 *
 * 这一区之前是十二个长得一模一样的输入框排成一列，四条专线靠一行小字分隔，
 * 而且标题写死「写稿专线 · Opus 4.8」——你把模型改掉，那行字还在说 Opus 4.8。
 * 两条改法：
 *   1. 每条路由一张卡，卡头显示**它此刻真实生效的模型**（读 settings:get 的 routes，
 *      没单独配就明说「跟随主通道强模型」），不再有写死的假标签。
 *   2. 每张卡一个「测试」——拿**已保存的**配置真发一次极小调用（settings:test_route），
 *      回耗时与上游实际回的模型名。配置面没有反馈闭环，等于让用户拿生产任务当探针。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Field, SaveRow, Section } from "./settings-kit";
import { slugProviderId } from "./provider-id";

type RouteView = { baseUrl: string; model: string; protocol?: string; models?: string[] } | null;
type RouteKey = "writer" | "analytics" | "scout" | "codex";

/** settings:get 回的一条端点：无 key、无掩码，只有一个"配没配" */
interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string | null;
  models: string[];
  apiKeySet: boolean;
}

interface EngineView {
  configured: boolean;
  apiKeyMasked: string | null;
  baseUrl: string;
  strongModel: string;
  fastModel: string;
  routes: Record<RouteKey, RouteView>;
  routePresets?: Record<RouteKey, { baseUrl: string; model: string }>;
  providers?: ProviderView[];
}

/** 表单里的一行。key 只在浏览器里活着（React key）；id 是落盘的那个，创建时生成一次后不再变 */
interface ProviderRow {
  key: string;
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  protocol: string;
  apiKey: string;
  apiKeySet: boolean;
  /** 服务端已存的模型清单——「测试」只能测已保存的那些，表单里刚敲的还不算数 */
  savedModels: string[];
}

let providerRowSeq = 0;

function toProviderRows(list: ProviderView[] | undefined): ProviderRow[] {
  return (list ?? []).map((p) => ({
    key: `saved-${p.id}`,
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models.join(", "),
    protocol: p.protocol ?? "",
    apiKey: "",
    apiKeySet: p.apiKeySet,
    savedModels: p.models,
  }));
}

const ROUTES: Array<{ key: RouteKey; title: string; note: string; baseField: string; modelField: string }> = [
  { key: "writer", title: "写稿专线", note: "生成初稿、改稿、平台适配", baseField: "writer_base_url", modelField: "writer_model" },
  { key: "analytics", title: "数据复盘专线", note: "复盘报告、campaign 重排", baseField: "analytics_base_url", modelField: "analytics_model" },
  { key: "scout", title: "选题评分专线", note: "雷达筛选、灵感提炼、深调研", baseField: "scout_base_url", modelField: "scout_model" },
  { key: "codex", title: "Codex 备用通道", note: "同一个 Key，可选 sol / terra / luna", baseField: "codex_base_url", modelField: "codex_model" },
];

type TestState =
  | { status: "running" }
  | { status: "ok"; ms: number; model: string }
  | { status: "fail"; error: string };

/** 只取主机名做卡头的紧凑展示；解析不了就原样显示（宁可长，不许骗） */
function host(url?: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TestButton(props: { label?: string; state?: TestState; disabled?: boolean; title?: string; onRun: () => void }) {
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

function TestLine(props: { label?: string; state?: TestState }) {
  const s = props.state;
  if (!s || s.status === "running") return null;
  const prefix = props.label ? `${props.label}：` : "";
  if (s.status === "fail") return <p className="mono set-test-fail">✗ {prefix}{s.error}</p>;
  return <p className="mono set-test-ok">✓ {prefix}通了 · {s.ms}ms · {s.model}</p>;
}

const EMPTY_FORM = {
  api_key: "", base_url: "", strong_model: "", fast_model: "",
  writer_base_url: "", writer_model: "", analytics_base_url: "", analytics_model: "",
  scout_base_url: "", scout_model: "", codex_base_url: "", codex_model: "",
};

export function EngineSection() {
  const [engine, setEngine] = useState<EngineView | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [eForm, setEForm] = useState({ ...EMPTY_FORM });
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const load = async () => {
    const r = await invoke("settings:get");
    if (!r.ok) return toast(r.error ?? "引擎配置读取失败");
    const d = (r as unknown as { data: EngineView }).data;
    setEngine(d);
    setProviders(toProviderRows(d.providers));
  };
  useEffect(() => {
    void load();
  }, []);

  const runTest = async (target: string) => {
    if (tests[target]?.status === "running") return;
    setTests((t) => ({ ...t, [target]: { status: "running" } }));
    const r = await invoke("settings:test_route", { target });
    if (!r.ok) {
      setTests((t) => ({ ...t, [target]: { status: "fail", error: r.error ?? "测试失败" } }));
      return;
    }
    const d = (r as unknown as { data: { ms: number; model: string } }).data;
    setTests((t) => ({ ...t, [target]: { status: "ok", ...d } }));
  };

  /** 表单里有没敲完就去测的东西——测的是已保存的配置，这件事必须当场说明白 */
  const dirty = Object.values(eForm).some((v) => v.trim() !== "");
  const testable = Boolean(engine?.configured);
  const testHint = !testable ? "先填 API Key 并保存，才能测试" : dirty ? "测的是已保存的配置——先保存再测" : undefined;

  const saveEngine = async () => {
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(eForm)) if (v.trim()) payload[k] = v.trim();
    if (Object.keys(payload).length === 0) return toast("没有要保存的修改");
    const r = await invoke("settings:set", payload);
    if (!r.ok) return toast(r.error ?? "保存失败");
    toast("已保存");
    setEForm({ ...EMPTY_FORM });
    setTests({}); // 配置换了，上一次的测试结论立刻作废，不许留在屏幕上冒充现状
    void load();
  };

  const patchProvider = (key: string, patch: Partial<ProviderRow>) =>
    setProviders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /**
   * 端点整份提交（服务端原子校验，任一条非法就整次拒绝并说清是哪条）。
   * id 在第一次提交前生成一次并留在表单里——之后改名不重算，切换器里存着的选择不会作废。
   */
  const saveProviders = async () => {
    const taken = new Set(providers.filter((p) => p.id).map((p) => p.id));
    const withIds = providers.map((p) => {
      if (p.id) return p;
      const id = slugProviderId(p.name, taken);
      taken.add(id);
      return { ...p, id };
    });
    setProviders(withIds);
    const payload = withIds.map((p) => ({
      id: p.id,
      name: p.name.trim(),
      baseUrl: p.baseUrl.trim(),
      models: p.models.split(/[,，\s]+/).filter(Boolean),
      ...(p.protocol ? { protocol: p.protocol } : {}),
      ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
    }));
    const r = await invoke("settings:set", { providers: payload });
    if (!r.ok) return toast(r.error ?? "保存失败"); // 服务端的原因原样展示,不改写
    toast(payload.length ? "端点已保存——对话切换器里可以选了" : "端点已清空");
    setTests({});
    void load();
  };

  return (
    <Section
      title="引擎 · 模型服务"
      status={engine?.configured ? `已配置 ${engine.apiKeyMasked ?? ""}` : "未配置"}
      on={engine?.configured}
    >
      <p className="muted">
        总编辑与轻任务走主通道；写稿、复盘、选题可各走更强的专线。所有路由共用同一个 API Key，不重复保存凭证。
        每张卡的「测试」会拿已保存的配置真发一次极小调用。
      </p>

      <div className="set-route">
        <div className="set-route-head">
          <span className="set-route-name">主通道</span>
          <span className="mono muted set-route-now">
            {host(engine?.baseUrl)} · 强 {engine?.strongModel ?? "—"} · 快 {engine?.fastModel ?? "—"}
          </span>
        </div>
        <Field label="API Key" password value={eForm.api_key} placeholder={engine?.apiKeyMasked ?? "sk-..."} onChange={(v) => setEForm((f) => ({ ...f, api_key: v }))} />
        <Field label="Base URL" value={eForm.base_url} placeholder={engine?.baseUrl ?? ""} onChange={(v) => setEForm((f) => ({ ...f, base_url: v }))} />
        <Field label="强模型" value={eForm.strong_model} placeholder={engine?.strongModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, strong_model: v }))} />
        <Field label="快模型" value={eForm.fast_model} placeholder={engine?.fastModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, fast_model: v }))} />
        <div className="set-route-foot">
          <TestButton label="测强档" state={tests.strong} disabled={!testable} {...(testHint ? { title: testHint } : {})} onRun={() => void runTest("strong")} />
          <TestButton label="测快档" state={tests.fast} disabled={!testable} {...(testHint ? { title: testHint } : {})} onRun={() => void runTest("fast")} />
          {testHint && <span className="mono muted">{testHint}</span>}
        </div>
        <TestLine label="强档" state={tests.strong} />
        <TestLine label="快档" state={tests.fast} />
      </div>

      <p className="mono muted set-sub-head">任务专线 · 留空即跟随主通道强模型</p>
      <div className="set-route-grid">
        {ROUTES.map((r) => {
          const route = engine?.routes?.[r.key] ?? null;
          const preset = engine?.routePresets?.[r.key];
          return (
            <div key={r.key} className="set-route">
              <div className="set-route-head">
                <span className="set-route-name">{r.title}</span>
                {/* 卡头说的是**此刻真实生效**的那一档，不是写死的宣传语 */}
                <span className="mono muted set-route-now">
                  {route ? `${route.model} · ${host(route.baseUrl)}` : `跟随主通道强模型 · ${engine?.strongModel ?? "—"}`}
                </span>
              </div>
              <p className="muted set-route-note">{r.note}</p>
              <Field
                label="端点"
                value={eForm[r.baseField as keyof typeof eForm]}
                placeholder={route?.baseUrl ?? preset?.baseUrl ?? ""}
                onChange={(v) => setEForm((f) => ({ ...f, [r.baseField]: v }))}
              />
              <Field
                label="模型"
                value={eForm[r.modelField as keyof typeof eForm]}
                placeholder={route?.model ?? preset?.model ?? ""}
                onChange={(v) => setEForm((f) => ({ ...f, [r.modelField]: v }))}
              />
              <div className="set-route-foot">
                <TestButton state={tests[r.key]} disabled={!testable} {...(testHint ? { title: testHint } : {})} onRun={() => void runTest(r.key)} />
              </div>
              <TestLine state={tests[r.key]} />
            </div>
          );
        })}
      </div>

      <SaveRow label="保存引擎与任务路由" onSave={() => void saveEngine()} />

      <p className="mono muted set-sub-head">
        自定义端点 · 总编辑对话的模型切换器里按端点分组直接选（不影响上面的主通道与任务路由）
      </p>
      {providers.length === 0 && <p className="muted">还没有自定义端点。加一个，比如本地 Ollama 或另一家中转。</p>}
      {providers.map((p) => {
        const target = p.savedModels[0] ? `p:${p.id}:${p.savedModels[0]}` : "";
        return (
          <div key={p.key} className="set-route set-provider">
            <div className="set-route-head">
              <span className="set-route-name">{p.name.trim() || "未命名端点"}</span>
              <span className="mono muted set-route-now">{p.id || "保存后分配 id"}</span>
              <button onClick={() => setProviders((rows) => rows.filter((r) => r.key !== p.key))}>删除</button>
            </div>
            <Field label="名称" value={p.name} placeholder="如:DeepSeek 官方" onChange={(v) => patchProvider(p.key, { name: v })} />
            <Field label="地址" value={p.baseUrl} placeholder="https://api.deepseek.com" onChange={(v) => patchProvider(p.key, { baseUrl: v })} />
            <Field
              label="模型"
              value={p.models}
              placeholder="逗号分隔,如:deepseek-v4-pro, deepseek-v4-flash"
              onChange={(v) => patchProvider(p.key, { models: v })}
            />
            <label className="set-field">
              <span className="mono muted">协议</span>
              <select value={p.protocol} onChange={(e) => patchProvider(p.key, { protocol: e.target.value })}>
                <option value="">自动推断(按 key 前缀与域名)</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </label>
            <Field
              label="API Key"
              password
              value={p.apiKey}
              placeholder={p.apiKeySet ? "已配置,留空保持不变" : "必填"}
              onChange={(v) => patchProvider(p.key, { apiKey: v })}
            />
            <div className="set-route-foot">
              <TestButton
                label={p.savedModels[0] ? `测 ${p.savedModels[0]}` : "测试"}
                state={tests[target]}
                disabled={!target}
                title={target ? "用已保存的地址与 key 测第一个模型" : "先保存这个端点，才能测"}
                onRun={() => void runTest(target)}
              />
            </div>
            <TestLine state={tests[target]} />
          </div>
        );
      })}
      <div className="set-save">
        <button
          onClick={() =>
            setProviders((rows) => [
              ...rows,
              { key: `new-${(providerRowSeq += 1)}`, id: "", name: "", baseUrl: "", models: "", protocol: "", apiKey: "", apiKeySet: false, savedModels: [] },
            ])
          }
        >
          ＋添加端点
        </button>
        <button className="primary" onClick={() => void saveProviders()}>保存端点</button>
        <button
          onClick={async () => {
            const r = await invoke("settings:open_config");
            if (!r.ok) return toast(r.error ?? "打开失败");
            const d = (r as unknown as { data: { path: string; opened: boolean } }).data;
            toast(d.opened ? `已打开 ${d.path}` : `请手动打开 ${d.path}`);
          }}
        >
          打开配置文件
        </button>
      </div>
    </Section>
  );
}
