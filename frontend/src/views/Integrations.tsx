/**
 * 设置 · 接入更多（P2 spec §5.3）——**可选**接入独立成一个标签，不和必填的模型钥匙并排。
 *
 * 每张卡固定三段：**解锁什么 · 不配会怎样 · 状态**。第二段写的是今天的真实行为
 * （搜索没配深调研就点不动、稿子出「未补证」徽章），不是营销话术——
 * 用户凭这一句决定要不要现在去弄第二把钥匙。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Field, SaveRow } from "./settings-kit";
import { integrationStatus, type IntegrationStatus } from "./integrations-lib";

interface RadarSource {
  id?: string;
  name: string;
  enabled?: boolean;
  config?: { url?: string; keyword?: string };
  [k: string]: unknown;
}

interface SearchView {
  configured: boolean;
  provider: string | null;
  apiKeyMasked: string | null;
}

interface PublishView {
  imageConfigured: boolean;
  imageApiKeyMasked: string | null;
  imageBaseUrl: string | null;
  imageModel: string | null;
  imageChain: Array<{ name: string | null; kind: string; baseUrl: string | null; apiKeyMasked: string | null; model: string | null; dialect: string }>;
  theme: string | null;
  themes: Array<{ id: string; name: string }>;
  author: string | null;
  apiProxyConfigured: boolean;
  wechatConfigured: boolean;
  wechatAppIdMasked: string | null;
  openComment: boolean;
  xApiKeyMasked: string | null;
  redditClientIdMasked: string | null;
  redditConfigured: boolean;
}

interface CoverView {
  provider: string;
  relay: { configured: boolean; model: string | null };
  gemini: { configured: boolean; apiKeyMasked: string | null; source: string; model: string };
}

interface InboxSettingsView {
  configured: boolean;
  botTokenMasked: string | null;
  allowedUserIds: string[];
  targetWorkspaceId: string;
  proxyUrlMasked: string | null;
  justoneapiConfigured: boolean;
  justoneapiKeyMasked: string | null;
}

/** 收件箱 runtime：`poller.lastError` 是全五张卡里**唯一**一个真有「上次失败」的字段 */
interface InboxRuntimeView {
  state: string;
  detail?: string;
  poller?: { state: string; lastPollOkAt?: string; lastUpdateId?: number; lastError?: string };
}

const EMPTY_PUBLISH_FORM = {
  image_api_key: "", image_base_url: "", image_model: "", image_chain: "", theme: "", author: "", api_proxy: "",
  wechat_app_id: "", wechat_app_secret: "", open_comment: "", x_api_key: "", reddit_client_id: "", reddit_client_secret: "",
};

const EMPTY_INBOX_FORM = { bot_token: "", allowed_user_ids: "", target_workspace_id: "", proxy_url: "", justoneapi_key: "" };

function IntegrationCard(props: {
  title: string;
  unlocks: string;
  ifMissing: string;
  status: IntegrationStatus;
  children: React.ReactNode;
}) {
  return (
    <section className="set-zone">
      <div className="set-head">
        <h3 className="serif set-title">{props.title}</h3>
        <span className={`chip int-${props.status.tone}`}>{props.status.text}</span>
      </div>
      <p className="muted int-line">
        <span className="mono">解锁什么</span>　{props.unlocks}
      </p>
      <p className="muted int-line">
        <span className="mono">不配会怎样</span>　{props.ifMissing}
      </p>
      {props.children}
    </section>
  );
}

export function Integrations() {
  const [search, setSearch] = useState<SearchView | null>(null);
  const [sForm, setSForm] = useState({ provider: "bocha", api_key: "" });
  const [pub, setPub] = useState<PublishView | null>(null);
  const [pForm, setPForm] = useState({ ...EMPTY_PUBLISH_FORM });
  const [cover, setCover] = useState<CoverView | null>(null);
  const [cForm, setCForm] = useState({ provider: "", relay_model: "", gemini_api_key: "", gemini_model: "" });
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [inbox, setInbox] = useState<InboxSettingsView | null>(null);
  const [inboxRuntime, setInboxRuntime] = useState<InboxRuntimeView | null>(null);
  const [iForm, setIForm] = useState({ ...EMPTY_INBOX_FORM });
  const [ws, setWs] = useState<{ active: string; workspaces: Array<{ id: string; name: string }> } | null>(null);

  const load = async () => {
    const [sr, pr, cr, rr, ir, runtime, wr] = await Promise.all([
      invoke("settings:search_get"),
      invoke("settings:publish_get"),
      invoke("settings:cover_get"),
      invoke("radar:status"),
      invoke("inbox:settings_get"),
      invoke("inbox:status"),
      invoke("workspace:list"),
    ]);
    if (sr.ok) setSearch((sr as unknown as { data: SearchView }).data);
    if (pr.ok) setPub((pr as unknown as { data: PublishView }).data);
    if (cr.ok) setCover((cr as unknown as { data: CoverView }).data);
    if (rr.ok) setSources((rr as unknown as { data: { sources?: RadarSource[] } }).data?.sources ?? []);
    if (ir.ok) setInbox((ir as unknown as { data: InboxSettingsView }).data);
    if (runtime.ok) setInboxRuntime((runtime as unknown as { data: InboxRuntimeView }).data);
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

  const enabledSources = sources.filter((s) => s.enabled !== false).length;
  const coverOn = cover ? (cover.provider === "relay" ? cover.relay.configured : cover.gemini.configured) : false;

  return (
    <>
      <IntegrationCard
        title="搜索 · 博查 / Tavily"
        unlocks="深调研全网取证、写稿时按缺口定向补证据。"
        ifMissing="深调研按钮点不动；写稿照常出稿，但没有出处的数字会让稿子挂上「未补证」。"
        status={integrationStatus({
          configured: Boolean(search?.configured),
          okLabel: search?.provider ? `已配置 ${search.provider}` : "已配置",
        })}
      >
        <label className="set-field">
          <span className="mono muted">来源</span>
          <select value={sForm.provider} onChange={(e) => setSForm((f) => ({ ...f, provider: e.target.value }))}>
            <option value="bocha">博查 bocha（中文优先）</option>
            <option value="tavily">Tavily（英文圈）</option>
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
      </IntegrationCard>

      <IntegrationCard
        title="情报源 · 雷达订阅"
        unlocks="X / Reddit / YouTube 等源进雷达，命中定位的候选自动入灵感库。"
        ifMissing="缺 Key 的源每轮扫描都会静默失败，雷达只剩免费源，灵感库进的东西变少。"
        status={integrationStatus({ configured: enabledSources > 0, okLabel: `${enabledSources}/${sources.length} 开启` })}
      >
        {sources.map((s, i) => (
          <div key={s.id ?? s.name ?? i} className="row">
            <span className="mono pri">{s.enabled === false ? "关" : "开"}</span>
            <span className="row-title">{s.name}</span>
            <span className="muted mono">{(s.config?.url ?? s.config?.keyword ?? "").slice(0, 40)}</span>
            <button onClick={() => void toggleSource(i)}>{s.enabled === false ? "启用" : "停用"}</button>
          </div>
        ))}
        <Field label="X 源 Key" password value={pForm.x_api_key} placeholder={pub?.xApiKeyMasked ?? "twitterapi.io key——启用「X」源前先填"} onChange={(v) => setPForm((f) => ({ ...f, x_api_key: v }))} />
        <Field label="Reddit Client ID" password value={pForm.reddit_client_id} placeholder={pub?.redditClientIdMasked ?? "reddit.com/prefs/apps 建 script 应用"} onChange={(v) => setPForm((f) => ({ ...f, reddit_client_id: v }))} />
        <Field label="Reddit Client Secret" password value={pForm.reddit_client_secret} placeholder={pub?.redditConfigured ? "已保存（重填即覆盖）" : "同一页面的 secret"} onChange={(v) => setPForm((f) => ({ ...f, reddit_client_secret: v }))} />
        <SaveRow
          label="保存情报源凭据"
          onSave={() =>
            void submit(
              "settings:publish_set",
              { x_api_key: pForm.x_api_key, reddit_client_id: pForm.reddit_client_id, reddit_client_secret: pForm.reddit_client_secret },
              () => setPForm((f) => ({ ...f, x_api_key: "", reddit_client_id: "", reddit_client_secret: "" })),
            )
          }
        />
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
      </IntegrationCard>

      <IntegrationCard
        title="公众号发布"
        unlocks="一键把定稿推进公众号草稿箱，用你自己的号。"
        ifMissing="发布面板的「推草稿」置灰；只能自己复制正文去后台贴。"
        status={integrationStatus({
          configured: Boolean(pub?.wechatConfigured),
          okLabel: pub?.wechatAppIdMasked ? `已绑定 ${pub.wechatAppIdMasked}` : "已绑定",
        })}
      >
        <Field label="公众号 AppID" value={pForm.wechat_app_id} placeholder={pub?.wechatAppIdMasked ?? "wx…"} onChange={(v) => setPForm((f) => ({ ...f, wechat_app_id: v }))} />
        <Field label="公众号 AppSecret" password value={pForm.wechat_app_secret} placeholder={pub?.wechatConfigured ? "已保存（重填即覆盖）" : "后台生成后粘贴"} onChange={(v) => setPForm((f) => ({ ...f, wechat_app_secret: v }))} />
        <label className="set-field">
          <span className="mono muted">推草稿默认打开留言</span>
          <select value={pForm.open_comment} onChange={(e) => setPForm((f) => ({ ...f, open_comment: e.target.value }))}>
            <option value="">当前：{pub?.openComment ? "开" : "关"}（不改）</option>
            <option value="1">开</option>
            <option value="0">关</option>
          </select>
        </label>
        <label className="set-field">
          <span className="mono muted">排版主题</span>
          <select value={pForm.theme} onChange={(e) => setPForm((f) => ({ ...f, theme: e.target.value }))}>
            <option value="">当前：{pub?.theme ?? "newspaper"}（不改）</option>
            {(pub?.themes ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}（{t.id}）</option>
            ))}
          </select>
        </label>
        <Field label="署名" value={pForm.author} placeholder={pub?.author ?? "Lawrence"} onChange={(v) => setPForm((f) => ({ ...f, author: v }))} />
        <Field label="API 代理" value={pForm.api_proxy} placeholder={pub?.apiProxyConfigured ? "已配置（不回显）——填新值覆盖" : "http://user:pass@固定IP:端口（可选，锁定出口）"} onChange={(v) => setPForm((f) => ({ ...f, api_proxy: v }))} />
        <SaveRow label="保存公众号配置" onSave={() => void submit("settings:publish_set", pForm, () => setPForm({ ...EMPTY_PUBLISH_FORM }))} />
      </IntegrationCard>

      <IntegrationCard
        title="生图 · 封面"
        unlocks="正文配图与封面生成（形象照放进 covers/templates 还能锁人物一致性）。"
        ifMissing="生成配图与封面会直接报错说没配；稿子只能纯文字发。"
        status={integrationStatus({
          configured: Boolean(pub?.imageConfigured) && coverOn,
          okLabel: `生图${pub?.imageConfigured ? " ✓" : " ✗"} · 封面走${cover?.provider === "gemini" ? " Gemini" : "中转"}`,
        })}
      >
        <Field label="生图 Key" password value={pForm.image_api_key} placeholder={pub?.imageApiKeyMasked ?? "sk-..."} onChange={(v) => setPForm((f) => ({ ...f, image_api_key: v }))} />
        <Field label="生图端点" value={pForm.image_base_url} placeholder={pub?.imageBaseUrl ?? "https://api.xiaojiu.one/v1"} onChange={(v) => setPForm((f) => ({ ...f, image_base_url: v }))} />
        <Field label="生图模型" value={pForm.image_model} placeholder={pub?.imageModel ?? "gpt-image-2"} onChange={(v) => setPForm((f) => ({ ...f, image_model: v }))} />
        <label className="set-field set-field-wide">
          <span className="mono muted">
            生图通道链（有序，第一个出图的赢；留空 = 只用上面那个端点）
            {pub?.imageChain?.length ? `　当前链：${pub.imageChain.map((f) => f.name || f.baseUrl || f.kind).join(" → ")}` : ""}
          </span>
          <textarea
            rows={4}
            className="mono"
            value={pForm.image_chain}
            placeholder={'[{"kind":"codex"},\n {"name":"newcli","baseUrl":"https://code.newcli.com/codex/v1","apiKey":"sk-...","model":"gpt-image-2"}]'}
            onChange={(e) => setPForm((f) => ({ ...f, image_chain: e.target.value }))}
          />
        </label>
        <SaveRow label="保存生图配置" onSave={() => void submit("settings:publish_set", pForm, () => setPForm({ ...EMPTY_PUBLISH_FORM }))} />
        <label className="set-field">
          <span className="mono muted">封面通道</span>
          <select value={cForm.provider} onChange={(e) => setCForm((f) => ({ ...f, provider: e.target.value }))}>
            <option value="">不改（当前 {cover?.provider === "gemini" ? "Gemini" : "中转 image2"}）</option>
            <option value="relay">中转 image2（推荐，复用上面的生图凭证）</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <Field label="中转模型" value={cForm.relay_model} placeholder={cover?.relay.model ?? "gpt-image-2"} onChange={(v) => setCForm((f) => ({ ...f, relay_model: v }))} />
        <Field label="Gemini Key" password value={cForm.gemini_api_key} placeholder={cover?.gemini.apiKeyMasked ?? "AIza...（切 Gemini 才需要）"} onChange={(v) => setCForm((f) => ({ ...f, gemini_api_key: v }))} />
        <SaveRow label="保存封面配置" onSave={() => void submit("settings:cover_set", cForm, () => setCForm({ provider: "", relay_model: "", gemini_api_key: "", gemini_model: "" }))} />
      </IntegrationCard>

      <IntegrationCard
        title="Telegram 收件箱"
        unlocks="手机上刷到好内容转发给自己的 bot，异步消化成灵感或对标拆解卡。"
        ifMissing="灵感只能回电脑手动录入；不配不影响任何其它功能。"
        status={integrationStatus({
          configured: Boolean(inbox?.configured),
          // `poller` 只有 lastError 没有它的时间戳（后端待补 lastErrorAt）——
          // 拿 lastPollOkAt 冒充失败时间就是撒谎，宁可只报原因
          ...(inboxRuntime?.poller?.lastError ? { lastError: inboxRuntime.poller.lastError } : {}),
          okLabel: inbox?.botTokenMasked ? `已配对 ${inbox.botTokenMasked}` : "已配对",
        })}
      >
        <Field label="Bot Token" password value={iForm.bot_token} placeholder={inbox?.botTokenMasked ?? "123456:AA…（BotFather 给的那串）"} onChange={(v) => setIForm((f) => ({ ...f, bot_token: v }))} />
        <Field label="允许的 user id" value={iForm.allowed_user_ids} placeholder={inbox?.allowedUserIds.length ? inbox.allowedUserIds.join(", ") : "你自己的数字 id，多个用逗号分隔"} onChange={(v) => setIForm((f) => ({ ...f, allowed_user_ids: v }))} />
        <label className="set-field">
          <span className="mono muted">消息落哪个工作区</span>
          <select value={iForm.target_workspace_id} onChange={(e) => setIForm((f) => ({ ...f, target_workspace_id: e.target.value }))}>
            <option value="">
              当前：{ws?.workspaces.find((w) => w.id === inbox?.targetWorkspaceId)?.name ?? inbox?.targetWorkspaceId ?? "default"}（不改）
            </option>
            {(ws?.workspaces ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name}（{w.id}）</option>
            ))}
          </select>
        </label>
        <Field label="代理地址" value={iForm.proxy_url} placeholder={inbox?.proxyUrlMasked ?? "http://127.0.0.1:7890（大陆网络必填）"} onChange={(v) => setIForm((f) => ({ ...f, proxy_url: v }))} />
        <Field label="抖音解析 Key" password value={iForm.justoneapi_key} placeholder={inbox?.justoneapiKeyMasked ?? "justoneapi.com 的 token（转发抖音链接必填）"} onChange={(v) => setIForm((f) => ({ ...f, justoneapi_key: v }))} />
        <SaveRow label="保存收件箱配置" onSave={() => void submit("inbox:settings_set", iForm, () => setIForm({ ...EMPTY_INBOX_FORM }))} />
        <p className="muted mono">
          白名单外的消息一律静默忽略。保存即热重启轮询；换 bot 会重置消费游标。抖音解析：
          {inbox?.justoneapiConfigured ? "已配置" : "未配置——转发抖音链接会先挂起等 key"}
        </p>
      </IntegrationCard>
    </>
  );
}
