/**
 * 剪辑工作台（P6 §13.4-C）——`editing` 阶段（及视频稿封面）的整页台子。
 *
 * 剪辑在 Codex 对话和剪映里做，这一页只是看板：步骤条、「现在轮到你」、Codex 进度、文件与交接详情。
 * 这一页默认收起右侧总编辑栏（一点就开），离开后回到用户自己的偏好。
 */
import { useEffect } from "react";
import { ProjectBoard } from "./ProjectBoard";
import { requestDockCollapsed } from "../chat/dock-prefs";
import type { Content } from "../lib";

export function EditingWorkspace(props: { content: Content; reload: () => Promise<void> }) {
  useEffect(() => requestDockCollapsed(), []);
  return (
    <div className="ed-stage">
      <div className="ed-below pb-page" style={{ marginTop: 0 }}>
        <ProjectBoard content={props.content} reload={props.reload} />
      </div>
    </div>
  );
}
