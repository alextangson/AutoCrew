/**
 * 交接前的视频稿（draft_ready/approved）：写稿页顶上只留一行怎么交接。
 * 步骤条和封面字/时长不放这里——封面字由 Codex 在 confirm 时拟，创始人在 Mac 弹窗里确认；
 * 剪辑中的整页看板见 EditingWorkspace。
 */
const PRE_HANDOFF = new Set(["draft_ready", "approved"]);

/** 启用本体后不再交接：原片进收件箱、剪辑工位报事实，卡片自己推进 */
export const ONTOLOGY_PRE_EDIT = "录完把原片放进「我的内容/0 原片放这里」（文件名带标题），卡片会自己进「剪辑中」；审片、选封面在卡片上点。";

export function SharedProjectPanel(props: { status: string; isVideo: boolean; ontology?: boolean }) {
  if (!props.isVideo || !PRE_HANDOFF.has(props.status)) return null;
  return <p className="pb-pre muted">{props.ontology ? ONTOLOGY_PRE_EDIT : "录完按标题命名放进 Downloads，在 Codex 里说「剪这条」。"}</p>;
}
