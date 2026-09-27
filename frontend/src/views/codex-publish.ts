/**
 * 「让 Codex 发布」（纯函数）：什么时候给按钮、打开哪条 Codex 对话、交给 Codex 的发布指令长什么样。
 * AutoCrew 只准备文字、复制、打开对话；发送和发布永远是创始人自己按。
 */
import { currentStep, type Artifact, type ProjectReview } from "./project-board";
import { approvedVersion, coverVersions, versionLabel } from "./cover-board";

export type PublishButtonPlace = "board" | "publish_page";

/** 看板：待发布一步且还没登记（status=editing）；发布页：已登记 publish_ready 且两道门都批了 */
export function showCodexPublish(place: PublishButtonPlace, status: string, review: ProjectReview | null): boolean {
  if (!review?.enabled || !review.gates) return false;
  if (currentStep(review) !== "ready") return false;
  return place === "board" ? status === "editing" : status === "publish_ready";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 执行记录里的会话 id 是 Codex 对话 id（UUID）才算找得到；否则新开 */
export function codexThreadId(review: ProjectReview | null): string | null {
  const id = review?.execution?.session_id?.trim();
  return id && UUID.test(id) ? id.toLowerCase() : null;
}
export function codexTargetLine(review: ProjectReview | null): string {
  return codexThreadId(review) ? "会打开这条视频的剪辑对话" : "没找到这条视频的 Codex 对话，会新开一个，粘贴就行";
}

const VIDEO_PLATFORMS: Record<string, string> = {
  douyin: "抖音", 抖音: "抖音", wechat_video: "视频号", channels: "视频号", shipinhao: "视频号", 视频号: "视频号",
  xiaohongshu: "小红书", xhs: "小红书", 小红书: "小红书", bilibili: "B站", b站: "B站", B站: "B站",
};
/** 账号资料里的视频平台（抖音/视频号/小红书/B站），去重保序 */
export function videoPlatforms(platforms: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of platforms) {
    const name = VIDEO_PLATFORMS[p.trim()] ?? VIDEO_PLATFORMS[p.trim().toLowerCase()];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 发布默认平台 = 这条稿自己的平台（+ 兄弟变体的平台）；账号运营的其他视频平台只列成可选，不默认授权 */
export function publishPlatforms(own: readonly string[], operated: readonly string[]): { defaults: string[]; optional: string[] } {
  const defaults = videoPlatforms(own);
  return { defaults, optional: videoPlatforms(operated).filter((p) => !defaults.includes(p)) };
}

const join = (root: string | undefined, p: string) => (p.startsWith("/") || !root ? p : `${root.replace(/\/$/, "")}/${p}`);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export type FinalCutPlan = { path: string; moveFrom?: string };
/**
 * 成片：批准的那份字节。已挪进项目（final-cut）就用它；还只是剪映导出候选时，
 * 登记只收项目内的文件，所以目标写 07-delivery/<原名>，并记下要从哪挪过来。
 */
export function finalCutPlan(review: ProjectReview): FinalCutPlan | null {
  const root = review.project?.project_root ?? undefined;
  const sha = review.gates?.gate3.approval?.artifact_sha256;
  const hits = (review.execution?.artifacts ?? []).filter((a: Artifact) => a.sha256 === sha && (a.role === "final-cut" || a.role === "final-cut-candidate"));
  const inProject = hits.find((a) => a.role === "final-cut");
  if (inProject) return { path: join(root, inProject.path) };
  const p = hits[0]?.path ?? review.final_cut?.path;
  if (!p) return null;
  const at = join(root, p);
  if (!root) return { path: at };
  return { path: join(root, `07-delivery/${baseName(at)}`), moveFrom: at };
}

export function finalCutPath(review: ProjectReview): string | null {
  return finalCutPlan(review)?.path ?? null;
}

export type PublishMessageInput = { contentId: string; title: string; status: string; review: ProjectReview; platforms: string[] };
/** 发给 Codex 的发布指令（≤12 行）；只用看板上已有的事实 */
export function publishMessage(i: PublishMessageInput): string {
  const root = i.review.project?.project_root ?? undefined;
  const versions = coverVersions(i.review.execution?.artifacts ?? []);
  const approved = approvedVersion(versions, i.review.cover_selection, i.review.gates?.gate4);
  const pick = i.review.cover_selection ?? {};
  const plan = finalCutPlan(i.review);
  const cover = (r: "3:4" | "4:3") => (pick[r]?.path ? join(root, pick[r]!.path) : "（没找到）");
  const lines = [
    `发布这条视频：${i.title}。这条消息就是我对发布的授权。`,
    `content_id：${i.contentId}`,
    `成片：${plan?.path ?? "（没找到）"}`,
    `封面：${approved === null ? "已批准的那一版" : versionLabel(approved)}；3:4 ${cover("3:4")}；4:3 ${cover("4:3")}`,
    `平台：${i.platforms.length ? i.platforms.join("、") : "（请填写）"}`,
    "发布时间：立即发布",
    "步骤：",
  ];
  let n = 1;
  if (i.status !== "publish_ready" && plan?.moveFrom) lines.push(`${n++}. 先把成片挪进 07-delivery 再登记：把 ${plan.moveFrom} 挪到 ${plan.path}，用 autocrew_video report 报 final-cut`);
  if (i.status !== "publish_ready") lines.push(`${n++}. 还没登记：先用 autocrew_video status 取两道批准，再 autocrew_video register 登记`);
  lines.push(`${n++}. 用 publish-content 技能发到上面的平台，按技能说明匹配当前活动`);
  lines.push(`${n++}. 按技能说明把各平台回执回报给 AutoCrew`);
  return lines.join("\n");
}
