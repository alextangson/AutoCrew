/**
 * 设置中心(V5.6.3 重构):七区全展开卡片 + 状态徽标一眼可扫——之前折叠 details
 * 要点七次才见全貌。所有 key 掩码显示,原文永不出 server;留空的字段保持现状。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, openDialog } from "../ui";

function Section(props: { title: string; status?: string; on?: boolean; children: React.ReactNode }) {
  return (
    <section className="set-zone">
      <div className="set-head">
        <h3 className="serif set-title">{props.title}</h3>
        {props.status && <span className={"chip" + (props.on ? " chip-pub" : "")}>{props.status}</span>}
      </div>
      {props.children}
    </section>
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

/** 保存行:按钮 + 「留空保持现状」契约说明(占位符即当前值) */
function SaveRow(props: { label: string; onSave: () => void }) {
  return (
    <div className="set-save">
      <button className="primary" onClick={props.onSave}>
        {props.label}
      </button>
      <span className="muted mono">留空的字段保持现状(浅字即当前值)</span>
    </div>
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
  type RouteView = { baseUrl: string; model: string; protocol?: string; models?: string[] } | null;
  const [engine, setEngine] = useState<{
    configured: boolean;
    apiKeyMasked: string | null;
    baseUrl: string;
    strongModel: string;
    fastModel: string;
    routes: { writer: RouteView; analytics: RouteView; scout: RouteView; codex: RouteView };
  } | null>(null);
  const [eForm, setEForm] = useState({
    api_key: "",
    base_url: "",
    strong_model: "",
    fast_model: "",
    writer_base_url: "",
    writer_model: "",
    analytics_base_url: "",
    analytics_model: "",
    scout_base_url: "",
    scout_model: "",
    codex_base_url: "",
    codex_model: "",
  });
  const [search, setSearch] = useState<{ configured: boolean; provider: string | null; apiKeyMasked: string | null } | null>(null);
  const [sForm, setSForm] = useState({ provider: "bocha", api_key: "" });
  const [pub, setPub] = useState<{ imageConfigured: boolean; imageApiKeyMasked: string | null; imageBaseUrl: string | null; imageModel: string | null; theme: string | null; themes: Array<{ id: string; name: string }>; author: string | null; apiProxyConfigured: boolean; wechatConfigured: boolean; wechatAppIdMasked: string | null; openComment: boolean } | null>(null);
  const [pForm, setPForm] = useState({ image_api_key: "", image_base_url: "", image_model: "", theme: "", author: "", api_proxy: "", wechat_app_id: "", wechat_app_secret: "", open_comment: "" });
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

  const coverStatus = cover
    ? cover.provider === "relay"
      ? cover.relay.configured
        ? `中转 ${cover.relay.model ?? ""}`
        : "中转未配置"
      : cover.gemini.configured
        ? `Gemini ${cover.gemini.apiKeyMasked ?? ""}`
        : "Gemini 未配置"
    : "";
  const coverOn = cover ? (cover.provider === "relay" ? cover.relay.configured : cover.gemini.configured) : false;

  return (
    <div className="settings">
      <h2 className="serif">设置</h2>

      <Section title="引擎 · 模型服务" status={engine?.configured ? `已配置 ${engine.apiKeyMasked ?? ""}` : "未配置"} on={engine?.configured}>
        <p className="muted">总编辑与轻任务走主通道；写稿、复盘可单独走更强模型。所有路由共用同一个 API Key，不重复保存凭证。</p>
        <p className="muted">主通道:{engine?.baseUrl ?? "—"} · 强 {engine?.strongModel ?? "—"} · 快 {engine?.fastModel ?? "—"}</p>
        <Field label="API Key" password value={eForm.api_key} placeholder={engine?.apiKeyMasked ?? "sk-..."} onChange={(v) => setEForm((f) => ({ ...f, api_key: v }))} />
        <Field label="Base URL" value={eForm.base_url} placeholder={engine?.baseUrl ?? ""} onChange={(v) => setEForm((f) => ({ ...f, base_url: v }))} />
        <Field label="强模型" value={eForm.strong_model} placeholder={engine?.strongModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, strong_model: v }))} />
        <Field label="快模型" value={eForm.fast_model} placeholder={engine?.fastModel ?? ""} onChange={(v) => setEForm((f) => ({ ...f, fast_model: v }))} />
        <p className="mono muted">写稿专线 · Opus 4.8</p>
        <Field label="写稿端点" value={eForm.writer_base_url} placeholder={engine?.routes?.writer?.baseUrl ?? "https://code.newcli.com/claude/ultra"} onChange={(v) => setEForm((f) => ({ ...f, writer_base_url: v }))} />
        <Field label="写稿模型" value={eForm.writer_model} placeholder={engine?.routes?.writer?.model ?? "claude-opus-4-8"} onChange={(v) => setEForm((f) => ({ ...f, writer_model: v }))} />
        <p className="mono muted">数据复盘专线 · Opus 4.8</p>
        <Field label="复盘端点" value={eForm.analytics_base_url} placeholder={engine?.routes?.analytics?.baseUrl ?? "https://code.newcli.com/claude/ultra"} onChange={(v) => setEForm((f) => ({ ...f, analytics_base_url: v }))} />
        <Field label="复盘模型" value={eForm.analytics_model} placeholder={engine?.routes?.analytics?.model ?? "claude-opus-4-8"} onChange={(v) => setEForm((f) => ({ ...f, analytics_model: v }))} />
        <p className="mono muted">选题评分专线 · Sonnet 5</p>
        <Field label="选题端点" value={eForm.scout_base_url} placeholder={engine?.routes?.scout?.baseUrl ?? "https://code.newcli.com/claude/ultra"} onChange={(v) => setEForm((f) => ({ ...f, scout_base_url: v }))} />
        <Field label="选题模型" value={eForm.scout_model} placeholder={engine?.routes?.scout?.model ?? "claude-sonnet-5"} onChange={(v) => setEForm((f) => ({ ...f, scout_model: v }))} />
        <p className="mono muted">Codex 备用通道 · 同 Key 可选 sol / terra / luna</p>
        <Field label="Codex 端点" value={eForm.codex_base_url} placeholder={engine?.routes?.codex?.baseUrl ?? "https://code.newcli.com/codex/v1"} onChange={(v) => setEForm((f) => ({ ...f, codex_base_url: v }))} />
        <Field label="Codex 默认模型" value={eForm.codex_model} placeholder={engine?.routes?.codex?.model ?? "gpt-5.6-sol"} onChange={(v) => setEForm((f) => ({ ...f, codex_model: v }))} />
        <SaveRow
          label="保存引擎与任务路由"
          onSave={() =>
            void submit("settings:set", eForm, () =>
              setEForm({
                api_key: "", base_url: "", strong_model: "", fast_model: "",
                writer_base_url: "", writer_model: "", analytics_base_url: "", analytics_model: "",
                scout_base_url: "", scout_model: "",
                codex_base_url: "", codex_model: "",
              }),
            )
          }
        />
      </Section>

      <Section title="搜索 · 侦查员外网搜集" status={search?.configured ? `已配置 ${search.provider}` : "未配置"} on={search?.configured}>
        <p className="muted">配好后总编辑就能派侦查员按定位全网搜灵感。推荐:博查(中文)/Tavily(英文)。</p>
        <label className="set-field">
          <span className="mono muted">Provider</span>
          <select value={sForm.provider} onChange={(e) => setSForm((f) => ({ ...f, provider: e.target.value }))}>
            <option value="bocha">博查 bocha(中文优先)</option>
            <option value="tavily">Tavily(英文圈)</option>
          </select>
        </label>
        <Field label="API Key" password value={sForm.api_key} placeholder={search?.apiKeyMasked ?? "sk-..."} onChange={(v) => setSForm((f) => ({ ...f, api_key: v }))} />
        <div className="set-save">
          <button
            className="primary"
            onClick={() => {
              if (!sForm.api_key.trim()) return toast("请填入 API key");
              void submit("settings:search_set", sForm, () => setSForm((f) => ({ ...f, api_key: "" })));
            }}
          >
            保存搜索配置
          </button>
        </div>
      </Section>

      <Section
        title="发布 · 公众号与生图"
        status={pub ? `${pub.imageConfigured ? "生图 ✓" : "生图未配置"} · ${pub.wechatConfigured ? `公众号 ${pub.wechatAppIdMasked ?? "✓"}` : "公众号未绑定"}` : ""}
        on={pub?.imageConfigured}
      >
        <p className="muted">
          公众号推草稿、文章配图与封面生成都走这里(存 publish.json)。生图 key 与端点必须配对(否则 401);
          公众号 AppID/AppSecret 在 mp.weixin.qq.com「设置与开发 · 开发接口管理」获取——绑定后推草稿用你自己的号,
          未绑定时沿用发布脚本自带配置(兜底);原创声明与赞赏是官方接口不支持的,群发时手点。
        </p>
        <Field label="生图 Key" password value={pForm.image_api_key} placeholder={pub?.imageApiKeyMasked ?? "sk-..."} onChange={(v) => setPForm((f) => ({ ...f, image_api_key: v }))} />
        <Field label="生图端点" value={pForm.image_base_url} placeholder={pub?.imageBaseUrl ?? "https://api.xiaojiu.one/v1"} onChange={(v) => setPForm((f) => ({ ...f, image_base_url: v }))} />
        <Field label="生图模型" value={pForm.image_model} placeholder={pub?.imageModel ?? "gpt-image-2"} onChange={(v) => setPForm((f) => ({ ...f, image_model: v }))} />
        <Field label="公众号 AppID" value={pForm.wechat_app_id} placeholder={pub?.wechatAppIdMasked ?? "wx…"} onChange={(v) => setPForm((f) => ({ ...f, wechat_app_id: v }))} />
        <Field label="公众号 AppSecret" password value={pForm.wechat_app_secret} placeholder={pub?.wechatConfigured ? "已保存(重填即覆盖)" : "后台生成后粘贴"} onChange={(v) => setPForm((f) => ({ ...f, wechat_app_secret: v }))} />
        <label className="set-field">
          <span className="mono muted">推草稿默认打开留言</span>
          <select value={pForm.open_comment} onChange={(e) => setPForm((f) => ({ ...f, open_comment: e.target.value }))}>
            <option value="">当前:{pub?.openComment ? "开" : "关"}(不改)</option>
            <option value="1">开</option>
            <option value="0">关</option>
          </select>
        </label>
        <label className="set-field">
          <span className="mono muted">排版主题</span>
          <select value={pForm.theme} onChange={(e) => setPForm((f) => ({ ...f, theme: e.target.value }))}>
            <option value="">当前:{pub?.theme ?? "newspaper"}(不改)</option>
            {(pub?.themes ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}（{t.id}）</option>
            ))}
          </select>
        </label>
        <Field label="署名" value={pForm.author} placeholder={pub?.author ?? "Lawrence"} onChange={(v) => setPForm((f) => ({ ...f, author: v }))} />
        <Field label="公众号 API 代理" value={pForm.api_proxy} placeholder={pub?.apiProxyConfigured ? "已配置(不回显)——填新值覆盖" : "http://user:pass@固定IP:端口(可选,锁定出口)"} onChange={(v) => setPForm((f) => ({ ...f, api_proxy: v }))} />
        <SaveRow label="保存发布配置" onSave={() => void submit("settings:publish_set", pForm, () => setPForm({ image_api_key: "", image_base_url: "", image_model: "", theme: "", author: "", api_proxy: "", wechat_app_id: "", wechat_app_secret: "", open_comment: "" }))} />
      </Section>

      <Section title="封面生成 · 生图通道" status={coverStatus} on={coverOn}>
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
        <SaveRow
          label="保存封面配置"
          onSave={() => void submit("settings:cover_set", cForm, () => setCForm({ provider: "", relay_model: "", gemini_api_key: "", gemini_model: "" }))}
        />
      </Section>

      <Section title="情报源" status={`${sources.filter((s) => s.enabled !== false).length}/${sources.length} 开启`} on={sources.some((s) => s.enabled !== false)}>
        <p className="muted">雷达订阅清单,命中定位语义筛才入灵感库。开关即改,手动扫榜生效。</p>
        {sources.map((s, i) => (
          <div key={s.id ?? s.name ?? i} className="row">
            <span className="mono pri">{s.enabled === false ? "关" : "开"}</span>
            <span className="row-title">{s.name}</span>
            <span className="muted mono">{typeof s.url === "string" ? s.url.slice(0, 40) : ""}</span>
            <button onClick={() => void toggleSource(i)}>{s.enabled === false ? "启用" : "停用"}</button>
          </div>
        ))}
        <div className="set-save">
          <button
            onClick={async () => {
              toast("扫榜中…");
              const r = await invoke("radar:refresh");
              toast(r.ok ? "扫榜完成——命中定位的候选已入灵感库" : (r.error ?? "扫榜失败"));
            }}
          >
            手动扫一轮
          </button>
        </div>
      </Section>

      <Section title="工作区" status={ws ? `当前 ${ws.workspaces.find((w) => w.id === ws.active)?.name ?? ws.active}` : ""} on>
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
        <div className="set-save">
          <button
            onClick={async () => {
              const v = await openDialog({
                title: "新建工作区",
                body: "每个工作区是独立编辑部——定位、灵感、稿件、画像全部隔离。创建后自动切换过去。",
                fields: [{ key: "name", label: "名称", placeholder: "如:Muse 公众号", required: true }],
                confirmLabel: "创建并切换",
              });
              if (!v) return;
              const r = await invoke("workspace:create", { name: v.name.trim() });
              if (!r.ok) return toast(r.error ?? "创建失败");
              toast("已创建并切换——刷新加载");
              window.location.reload();
            }}
          >
            ＋新建工作区
          </button>
        </div>
      </Section>

      <Section title="知识库" status={kb ? `${kb.count} 个文件` : ""} on={(kb?.count ?? 0) > 0}>
        <p className="muted">把你的笔记/干货文档(.md/.txt)放进 {kb?.dir ?? "…"},生成时自动检索注入。</p>
      </Section>
    </div>
  );
}
