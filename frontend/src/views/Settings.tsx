/**
 * 设置中心（P2 spec §5.3 重排）——两个标签，一条分界线：
 *
 *   「模型」= 必填的那把钥匙（端点表 / 主端点 / 备用 / 岗位）+ 工作区 + 知识库；
 *   「接入更多」= 全部可选接入，各自写明解锁什么、不配会怎样、现在什么状态；
 *   「数据回流」= 导入 CSV / 公众号拉取 / 自动回流开关（数据页规格 §G.42 从数据页挪来）。
 *
 * 不新增路由（spec §10 第 13 条）：标签是 `Route.tab`，「去设置」的深链能直接落到
 * 「模型」页，浏览器前进后退不会掉进一个没有导航的孤岛。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, openDialog } from "../ui";
import { Section } from "./settings-kit";
import { EngineSection } from "./SettingsEngine";
import { SettingsStorage } from "./SettingsStorage";
import { SettingsJianying } from "./SettingsJianying";
import { SettingsAsr } from "./SettingsAsr";
import { Integrations } from "./Integrations";
import { SettingsPublishGate } from "./SettingsPublishGate";
import { SettingsData } from "./SettingsData";
import { TRUST_NOTICE } from "../chat/backend-choice";
import type { Route } from "../routes";

export type SettingsTab = "models" | "integrations" | "data";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "models", label: "模型" },
  { id: "integrations", label: "接入更多" },
  { id: "data", label: "数据回流" },
];

/** 从主导航收进来的几页（看板规格 §27）：路由照旧，入口在这里 */
const MORE_PAGES: Array<{ view: "inbox" | "calibration" | "logs" | "library"; label: string; note: string }> = [
  { view: "inbox", label: "灵感收件箱", note: "随手记、转发进来的碎片" },
  { view: "calibration", label: "品牌校准", note: "口吻、受众、写作规则" },
  { view: "logs", label: "任务日志", note: "AI 做过的每一件事" },
  { view: "library", label: "素材库", note: "图片、视频、参考文件" },
];

function MorePages(props: { nav: (route: Route) => void }) {
  return <Section title="更多" status="" on>
    {MORE_PAGES.map((p) => <div key={p.view} className="row">
      <span className="row-title">{p.label} <span className="muted">· {p.note}</span></span>
      <button onClick={() => props.nav({ view: p.view })}>打开</button>
    </div>)}
  </Section>;
}

export function Settings(props: { tab?: SettingsTab; onTab?: (tab: SettingsTab) => void; nav?: (route: Route) => void }) {
  const [local, setLocal] = useState<SettingsTab>(props.tab ?? "models");
  const tab = props.tab ?? local;
  const setTab = (next: SettingsTab) => {
    setLocal(next);
    props.onTab?.(next);
  };
  const [kb, setKb] = useState<{ dir: string; count: number } | null>(null);
  const [ws, setWs] = useState<{ active: string; workspaces: Array<{ id: string; name: string }> } | null>(null);

  const load = async () => {
    const [kr, wr] = await Promise.all([invoke("knowledge:status"), invoke("workspace:list")]);
    if (kr.ok) setKb((kr as unknown as { data: typeof kb }).data);
    if (wr.ok) {
      const w = wr as unknown as { active?: string; workspaces?: Array<{ id: string; name: string }>; data?: { active: string; workspaces: Array<{ id: string; name: string }> } };
      setWs(w.data ?? { active: w.active ?? "default", workspaces: w.workspaces ?? [] });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="settings">
      <h2 className="serif">设置</h2>
      <nav className="set-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "nav-on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "data" && <SettingsData />}
      {tab === "integrations" && <><Integrations /><SettingsPublishGate /></>}
      {tab === "models" && (
        <>
          {props.nav && <MorePages nav={props.nav} />}
          <SettingsStorage />
          <SettingsJianying />
          <SettingsAsr />
          <EngineSection />

          <Section title="总编辑用本机 agent" status="本机 Claude" on>
            <p className="muted">{TRUST_NOTICE}</p>
            <p className="muted">在右栏输入框下方切换后端。本机 Claude 用你的 Claude 订阅，本机 Codex 用你的 ChatGPT 订阅。WorkBuddy 不在这里切换：到「接入更多 · 宿主」连接后，在 WorkBuddy 里直接调用 AutoCrew。内置引擎只在你手动选它时用，本机 agent 出错不会自动换过去。</p>
          </Section>

          <Section title="工作区" status={ws ? `当前 ${ws.workspaces.find((w) => w.id === ws.active)?.name ?? ws.active}` : ""} on>
            <p className="muted">一人多 IP：每个工作区是独立编辑部（定位/灵感/稿件/画像全隔离）。</p>
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
                    fields: [{ key: "name", label: "名称", placeholder: "如：Muse 公众号", required: true }],
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
            <p className="muted">把你的笔记/干货文档（.md/.txt）放进 {kb?.dir ?? "…"}，生成时自动检索注入。</p>
          </Section>
        </>
      )}
    </div>
  );
}
