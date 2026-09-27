/**
 * 剪辑工作台（P6 §13.4-C）——`editing` 阶段的整页台子。
 *
 * 剪辑在 Codex 对话和剪映里做，这一页只是看板：交接卡、产物、四道门、批准与打回。
 * 内置剪辑线（素材挂接、选段/计划/审片）已从这一页撤下；A-roll 只经交接进项目。
 */
import { SharedProjectPanel } from "./SharedProjectPanel";
import { ScriptPeek } from "./ScriptPeek";
import type { Content } from "../lib";

export function EditingWorkspace(props: { content: Content; reload: () => Promise<void> }) {
  return (
    <div className="ed-stage">
      <div className="ed-below" style={{ marginTop: 0 }}>
        <h2 className="serif">剪辑看板 · {props.content.title || "无标题"}</h2>
        <SharedProjectPanel contentId={props.content.id} status={props.content.status} isVideo reload={props.reload} />
        <ScriptPeek title={props.content.title} body={props.content.body} />
      </div>
    </div>
  );
}
