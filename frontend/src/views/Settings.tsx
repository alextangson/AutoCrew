/**
 * 设置中心(V5.6/P6 收口):引擎/搜索/发布(publish.json 可视化)/情报源/工作区/知识库,
 * 一页收口。所有 key 掩码显示,原文永不出 server。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

function Section(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <details className="set-zone">
      <summary>
        {props.title}
        {props.hint && <span className="muted"> · {props.hint}</span>}
      </summary>
      <div className="set-body">{props.children}</div>
    </details>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean }) {
  return (
    <label className="set-field">
      <span className="mono muted">{props.label}</span>
      <input
        type={props.password ? "password" : "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

interface RadarSource {
  id?: string;
  name: string;
  url?: string;
  enabled?: boolean;
  [k: string]: unknown;
}

export function Settings() {
  const [engine, setEngine] = useState<{ configured: boolean; apiKeyMasked: string | null; baseUrl: string; strongModel: string; fastModel: string } | null>(null);
  const [eForm, setEForm] = useState({ api_key: "", base_url: "", strong_model: "", fast_model: "" });
  const [search, setSearch] = useState<{ configured: boolean; provider: string | null; apiKeyMasked: string | null } | null>(null);
  const [sForm, setSForm] = useState({ provider: "bocha", api_key: "" });
  const [pub, setPub] = useState<{ imageConfigured: boolean; imageApiKeyMasked: string | null; imageBaseUrl: string | null; imageModel: string | null; theme: string | null; author: string | null } | null>(null);
  const [pForm, setPForm] = useState({ image_api_key: "", image_base_url: "", image_model: "", theme: "", author: "" });
  const [cover, setCover] = useState<{
    provider: string;
    relay: { configured: boolean; model: string | null };
    gemini: { configured: boolean; apiKeyMasked: string | null; source: string; model: string };
  } | null>(null);
  const [cForm, setCForm] = useState({ provider: "", relay_model: "", gemini_api_key: "", gemini_model: "" });
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [kb, setKb] = useState<{ dir: string; count: number } | null>(null);
  const [ws, setWs] = useState<{ active: string; workspaces: Array<{ id: string; name: string }> } | null>(null);

  const load = async () => {
    const [er, sr, pr, cr, rr, kr, wr] = await Promise.all([
      invoke("settings:get"),
      invoke("settings:search_get"),
      invoke("settings:publish_get"),
      invoke("settings:cover_get"),
      invoke("radar:status"),
      invoke("knowledge:status"),
      invoke("workspace:list"),
    ]);
    if (er.ok) setEngine((er as unknown as { data: typeof engine }).data);
    if (sr.ok) setSearch((sr as unknown as { data: typeof search }).data);
    if (pr.ok) setPub((pr as unknown as { data: typeof pub }).data);
    if (cr.ok) setCover((cr as unknown as { data: typeof cover }).data);
    if (rr.ok) setSources((((rr as unknown as { data: { sources?: RadarSource[] } }).data ?? {}).sources ?? []));
    if (kr.ok) setKb((kr as unknown as { data: typeof kb }).data);
    if (wr.ok) {
      const w = wr as unknown as { active?: string; workspaces?: Array<{ id: string; name: string }>; data?: { active: string; workspaces: Array<{ id: string; name: string }> } };
      setWs(w.data ?? { active: w.active ?? "default", workspaces: w.workspaces ?? [] });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const submit = async (channel: string, form: Record<string, string>, reset: () => void) => {
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (v.trim()) payload[k] = v.trim();
    if (Object.keys(payload).length === 0) return toast("没有要保存的修改");
    const r = await invoke(channel, payload);
    if (!r.ok) return toast(r.error ?? "保存失败");
    toast("已保存");
    reset();
    void load();
  };

  const toggleSource = async (idx: number) => {
    const next = sources.map((s, i) => (i === idx ? { ...s, enabled: s.enabled === false } : s));
    const r = await invoke("radar:sources_set", { sources: next });
    if (!r.ok) return toast(r.error ?? "保存失败");
    setSources(next);
    toast("源清单已保存——手动扫榜后生效");
  };

  return (
    <div className="settings">
      <h2 className="serif">设置</h2>

      <Section title="引擎 · 模型服务" hint={engine?.configured ? `已配置 ${engine.apiKeyMasked ?? ""}` : "未配置"}>
        <p className="muted">写稿、审稿、画像、复盘都吃这条通道(存 engine.json)。当前:{engine?.baseUrl ?? "—"} · 强 {engine?.strongModel ?? "—"} · 快 {engine?.fastModel ?? "—"}</p>
        <Field label="API Key" password value={eForm.api_key} placeholder={engine?.apiKeyMasked ?? "sk-..."} onChange={(v) => setEForm((f) => ({ ...f, api_key: v }))} />
        <Field label="Base URL" value={eForm.base_url} placeholder={engine?.baseUrl ?? ""} onChange={(v) => setEForm((f) => ({ ...f, base_url: v }))} />
        <Field label="强模型" value={eForm.strong_model} placeholder={engine?.strongModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, strong_model: v }))} />
        <Field label="快模型" value={eForm.fast_model} placeholder={engine?.fastModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, fast_model: v }))} />
        <button className="primary" onClick={() => void submit("settings:set", eForm, () => setEForm({ api_key: "", base_url: "", strong_model: "", fast_model: "" }))}>
          保存引擎配置
        </button>
      </Section>

      <Section title="搜索 · 侦查员外网搜集" hint={search?.configured ? `已配置 ${search.provider}` : "未配置"}>
        <p className="muted">配好后总编辑就能派侦查员按定位全网搜灵感。推荐:博查(中文)/Tavily(英文)。</p>
        <label className="set-field">
          <span className="mono muted">Provider</span>
          <select value={sForm.provider} onChange={(e) => setSForm((f) => ({ ...f, provider: e.target.value }))}>
            <option value="bocha">博查 bocha(中文优先)</option>
            <option value="tavily">Tavily(英文圈)</option>
          </select>
        </label>
        <Field label="API Key" password value={sForm.api_key} placeholder={search?.apiKeyMasked ?? "sk-..."} onChange={(v) => setSForm((f) => ({ ...f, api_key: v }))} />
        <button
          className="primary"
          onClick={() => {
            if (!sForm.api_key.trim()) return toast("请填入 API key");
            void submit("settings:search_set", sForm, () => setSForm((f) => ({ ...f, api_key: "" })));
          }}
        >
          保存搜索配置
        </button>
      </Section>

      <Section title="发布 · 公众号与生图" hint={pub?.imageConfigured ? `生图已配置 ${pub.imageApiKeyMasked ?? ""}` : "生图未配置"}>
        <p className="muted">公众号推草稿、文章配图与封面生成都走这条中转(存 publish.json);key 与端点必须配对(否则 401)。</p>
        <Field label="生图 Key" password value={pForm.image_api_key} placeholder={pub?.imageApiKeyMasked ?? "sk-..."} onChange={(v) => setPForm((f) => ({ ...f, image_api_key: v }))} />
        <Field label="生图端点" value={pForm.image_base_url} placeholder={pub?.imageBaseUrl ?? "https://api.xiaojiu.one/v1"} onChange={(v) => setPForm((f) => ({ ...f, image_base_url: v }))} />
        <Field label="生图模型" value={pForm.image_model} placeholder={pub?.imageModel ?? "gpt-image-2"} onChange={(v) => setPForm((f) => ({ ...f, image_model: v }))} />
        <Field label="排版主题" value={pForm.theme} placeholder={pub?.theme ?? "newspaper"} onChange={(v) => setPForm((f) => ({ ...f, theme: v }))} />
        <Field label="署名" value={pForm.author} placeholder={pub?.author ?? "Lawrence"} onChange={(v) => setPForm((f) => ({ ...f, author: v }))} />
        <button className="primary" onClick={() => void submit("settings:publish_set", pForm, () => setPForm({ image_api_key: "", image_base_url: "", image_model: "", theme: "", author: "" }))}>
          保存发布配置
        </button>
      </Section>

      <Section
        title="封面生成 · 生图通道"
        hint={
          cover
            ? cover.provider === "relay"
              ? cover.relay.configured
                ? `中转 ${cover.relay.model ?? ""}`
                : "中转未配置"
              : cover.gemini.configured
                ? `Gemini ${cover.gemini.apiKeyMasked ?? ""}`
                : "Gemini 未配置"
            : ""
        }
      >
        <p className="muted">
          默认走中转 image2——复用上面「发布」区的生图 Key/端点(公众号配图同一条,不用另配)。
          形象照放 ~/.autocrew/covers/templates/(jpg/png)自动带上做人物一致性;中转若不支持
          /images/edits 会自动降级无人物并明说。Gemini 保留为可选。
        </p>
        <label className="set-field">
          <span className="mono muted">生图通道</span>
          <select value={cForm.provider} onChange={(e) => setCForm((f) => ({ ...f, provider: e.target.value }))}>
            <option value="">不改(当前 {cover?.provider === "gemini" ? "Gemini" : "中转 image2"})</option>
            <option value="relay">中转 image2(推荐,复用发布区凭证)</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <Field label="中转模型" value={cForm.relay_model} placeholder={cover?.relay.model ?? "gpt-image-2"} onChange={(v) => setCForm((f) => ({ ...f, relay_model: v }))} />
        <Field label="Gemini Key" password value={cForm.gemini_api_key} placeholder={cover?.gemini.apiKeyMasked ?? "AIza...(切 Gemini 才需要)"} onChange={(v) => setCForm((f) => ({ ...f, gemini_api_key: v }))} />
        <label className="set-field">
          <span className="mono muted">Gemini 模型</span>
          <select value={cForm.gemini_model} onChange={(e) => setCForm((f) => ({ ...f, gemini_model: e.target.value }))}>
            <option value="">不改(当前 {cover?.gemini.model ?? "auto"})</option>
            <option value="auto">auto(native 优先)</option>
            <option value="gemini-native">gemini-native(支持形象照)</option>
            <option value="imagen-4">imagen-4</option>
          </select>
        </label>
        <button
          className="primary"
          onClick={() =>
            void submit("settings:cover_set", cForm, () => setCForm({ provider: "", relay_model: "", gemini_api_key: "", gemini_model: "" }))
          }
        >
          保存封面配置
        </button>
      </Section>

      <Section title="情报源" hint={`${sources.length} 个`}>
        <p className="muted">雷达订阅清单,命中定位语义筛才入灵感库。开关即改,手动扫榜生效。</p>
        {sources.map((s, i) => (
          <div key={s.id ?? s.name ?? i} className="row">
            <span className="mono pri">{s.enabled === false ? "关" : "开"}</span>
            <span className="row-title">{s.name}</span>
            <span className="muted mono">{typeof s.url === "string" ? s.url.slice(0, 40) : ""}</span>
            <button onClick={() => void toggleSource(i)}>{s.enabled === false ? "启用" : "停用"}</button>
          </div>
        ))}
        <button
          onClick={async () => {
            toast("扫榜中…");
            const r = await invoke("radar:refresh");
            toast(r.ok ? "扫榜完成——命中定位的候选已入灵感库" : (r.error ?? "扫榜失败"));
          }}
        >
          手动扫一轮
        </button>
      </Section>

      <Section title="工作区" hint={ws ? `当前 ${ws.workspaces.find((w) => w.id === ws.active)?.name ?? ws.active}` : ""}>
        <p className="muted">一人多 IP:每个工作区是独立编辑部(定位/灵感/稿件/画像全隔离)。</p>
        {ws?.workspaces.map((w) => (
          <div key={w.id} className="row">
            <span className="mono pri">{w.id === ws.active ? "当前" : ""}</span>
            <span className="row-title">{w.name}</span>
            {w.id !== ws.active && (
              <button
                onClick={async () => {
                  const r = await invoke("workspace:switch", { id: w.id });
                  if (!r.ok) return toast(r.error ?? "切换失败");
                  toast("已切换——刷新页面加载该编辑部");
                  window.location.reload();
                }}
              >
                切换
              </button>
            )}
          </div>
        ))}
        <button
          onClick={async () => {
            const name = window.prompt("新工作区名称(如:Muse 公众号)");
            if (!name?.trim()) return;
            const r = await invoke("workspace:create", { name: name.trim() });
            if (!r.ok) return toast(r.error ?? "创建失败");
            toast("已创建并切换——刷新加载");
            window.location.reload();
          }}
        >
          ＋新建工作区
        </button>
      </Section>

      <Section title="知识库" hint={kb ? `${kb.count} 个文件` : ""}>
        <p className="muted">把你的笔记/干货文档(.md/.txt)放进 {kb?.dir ?? "…"},生成时自动检索注入。</p>
      </Section>
    </div>
  );
}
