/**
 * 剪辑工作台（阶段制 spec §2）——`editing` 阶段的整页台子。
 *
 * 内容是既有面板的重排，不是重写：素材挂接（从文案页抽屉搬进来，A-roll/B-roll/BGM
 * 与常备池都在这儿）+ 成片卡与三道门（VideoPanel 原样升格整页）+ 只读文案。
 *
 * 一条纪律：**空态自己兜住**（spec §3①/§4）。状态是 editing 而视频线一个字都还没写，
 * 是完全正常的开局；就算状态与视频线错位，这一页也只会显示「还没开始剪」，绝不白屏。
 */
import { AssetsSection, isFinalAsset, type AssetItem } from "./AssetsSection";
import { VideoPanel } from "./VideoPanel";
import { ScriptPeek } from "./ScriptPeek";
import type { Content } from "../lib";

/** A-roll = 你对着镜头拍的那条。没有它整条线开不了工——所以它是「开始构建」的前置 */
export function findAroll(assets: AssetItem[]): AssetItem | null {
  return assets.find((a) => a.role === "aroll" && !isFinalAsset(a.filename)) ?? null;
}

export function EditingWorkspace(props: { content: Content; reload: () => Promise<void> }) {
  const assets = (props.content.assets ?? []).filter((a) => !isFinalAsset(a.filename));
  const aroll = findAroll(assets);

  return (
    <div className="ed-stage">
      <div className="ed-below" style={{ marginTop: 0 }}>
        <h2 className="serif">剪辑台 · {props.content.title || "无标题"}</h2>
        <p className="muted">
          挂 A-roll → 转写 → 你勾选留哪些句子 → 剪辑师排 B-roll → 你审片。片子审过之后，
          用顶栏「推进」进入封面阶段。
        </p>

        <details className="ed-tools" open>
          <summary>素材挂接{aroll ? " · A-roll 已就位" : " · 还差 A-roll"}</summary>
          {!aroll && (
            <p className="vid-warn">
              还没挂 A-roll（你对着镜头拍的那条口播）。从素材库挂一条、角色选「口播底轨」，
              才能开始构建。
            </p>
          )}
          <AssetsSection contentId={props.content.id} assets={assets} reload={props.reload} showPool />
        </details>

        <VideoPanel
          contentId={props.content.id}
          arollBlockReason={aroll ? null : "先在上面挂一条 A-roll（角色选「口播底轨」）"}
        />

        <ScriptPeek title={props.content.title} body={props.content.body} />
      </div>
    </div>
  );
}
