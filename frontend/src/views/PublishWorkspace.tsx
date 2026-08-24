/**
 * 发布工作台（阶段制 spec §2）——`publish_ready` 及之后的整页台子。
 *
 * 内容全是 EditorTools 里已有的那几块（发布件、预检、剪贴板/公众号推送、
 * 发布 URL 回填、数据回流），只是从窄抽屉里搬到整页：到了发布这一步，
 * 该干的活就是全部的活，不该再挤在侧边一条 320px 的缝里。
 */
import { EditorTools } from "./EditorTools";
import { ScriptPeek } from "./ScriptPeek";
import type { Content } from "../lib";
import type { VersionLike } from "../version-diff";

export function PublishWorkspace(props: {
  content: Content;
  versions: VersionLike[];
  reload: () => Promise<void>;
  send: (message: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <div className="ed-stage">
      <div className="ed-below" style={{ marginTop: 0 }}>
        <h2 className="serif">发布台 · {props.content.title || "无标题"}</h2>
        <p className="muted">排好文案去平台发，发完回来点确认——回流数据靠那一下认领。</p>
        <EditorTools
          contentId={props.content.id}
          content={props.content}
          versions={props.versions}
          dirty={false}
          reload={props.reload}
          send={props.send}
        />
        <ScriptPeek title={props.content.title} body={props.content.body} />
      </div>
    </div>
  );
}
