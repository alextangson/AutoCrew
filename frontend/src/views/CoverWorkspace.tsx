/**
 * 封面工作台（阶段制 spec §2）——`cover_pending` 阶段的整页台子。
 *
 * 顶部先摆成片首帧与标题：**封面是对着片子做的**，把它压在折叠面板下面、
 * 让人凭记忆想「片子长什么样」，正是上一版 IA 的毛病。
 *
 * 成片文件被人手删掉不拦推进（决策记录还在，文件可重建，spec §2 最坏输入），
 * 但这里必须说出来——对着一个放不出来的黑框做封面，人得知道为什么。
 */
import { useState } from "react";
import { CoverPanel } from "./CoverPanel";
import { ScriptPeek } from "./ScriptPeek";
import { videoMediaUrl, type Content } from "../lib";

export function CoverWorkspace(props: { content: Content; reload: () => Promise<void> }) {
  const [filmMissing, setFilmMissing] = useState(false);
  const rendered = props.content.videoDone?.renderedRevision ?? null;

  return (
    <div className="ed-stage">
      <div className="ed-below" style={{ marginTop: 0 }}>
        <div className="cover-stage-head">
          {rendered !== null && !filmMissing ? (
            <video
              className="cover-stage-film"
              src={videoMediaUrl(props.content.id, rendered)}
              preload="metadata"
              muted
              playsInline
              controls
              onError={() => setFilmMissing(true)}
            />
          ) : (
            <div className="cover-stage-film cover-missing muted">
              {rendered === null ? "这篇没有成片记录" : "成片文件找不到了"}
            </div>
          )}
          <div>
            <h2 className="serif">封面台 · {props.content.title || "无标题"}</h2>
            <p className="muted">封面要对着片子做——左边是这一版成片，挑一张配得上它的封面。</p>
            {filmMissing && (
              <p className="vid-warn">
                成片文件放不出来（多半是被手动删了）。封面照做不误，决策记录都在，
                要片子回来就退回剪辑台重出一版。
              </p>
            )}
          </div>
        </div>

        <CoverPanel contentId={props.content.id} platform={props.content.platform} />

        <ScriptPeek title={props.content.title} body={props.content.body} />
      </div>
    </div>
  );
}
