/**
 * 交接前的视频稿（draft_ready/approved）：写稿页顶上只留一行怎么交接。
 * 步骤条和封面字/时长不放这里——封面字由 Codex 在 confirm 时拟，创始人在 Mac 弹窗里确认；
 * 剪辑中的整页看板见 EditingWorkspace。
 */
const PRE_HANDOFF = new Set(["draft_ready", "approved"]);

/** 启用本体后不再交接：原片进收件箱、剪辑工位报事实，卡片自己推进 */
/**
 * 按 1b 的实际行为写（§10）：收件箱里文件名唯一对上标题的直接挪；名字对不上的按开头转写核对，对上了也自动挪
 * （卡片上可点「不是这条」撤回）；对不上的在待录制列头等你「指定给…」。监视文件夹只给建议。
 */
export const ONTOLOGY_PRE_EDIT = "录完把原片放进「我的内容/0 原片放这里」：文件名带标题的直接挪进项目；名字对不上的会听开头核对，对上了也自动挪（挂错了在卡片上点「不是这条」），对不上的在待录制列头等你指定。卡片会自己进「剪辑中」；审片、选封面在卡片上点。";

export function SharedProjectPanel(props: { status: string; isVideo: boolean; ontology?: boolean }) {
  if (!props.isVideo || !PRE_HANDOFF.has(props.status)) return null;
  return <p className="pb-pre muted">{props.ontology ? ONTOLOGY_PRE_EDIT : "录完按标题命名放进 Downloads，在 Codex 里说「剪这条」。"}</p>;
}
