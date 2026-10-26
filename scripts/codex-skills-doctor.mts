/**
 * `autocrew doctor` 的 Codex 一项：personal-ip-video-loop / publish-content / cover-generator 是否链到本安装；
 * 接了 Codex 时再查 AutoCrew 工具是否免审批（后台 Codex 任务审批策略 never，不免审批就调不了 AutoCrew 工具）。只输出 JSON。
 */
import { checkCodexSkills } from "../src/desktop/host-connect/codex-skills.js";
import { codexApprovalStatus } from "../src/desktop/host-connect/codex-approval.js";
import { codexHasEntry } from "../src/desktop/host-connect/detect.js";
import { defaultHostEnv } from "../src/desktop/host-connect/env.js";

const env = defaultHostEnv();
const approval = codexApprovalStatus(env, codexHasEntry(env));
console.log(JSON.stringify([...checkCodexSkills(env.codexHome, env.skillsRoot), ...(approval ? [approval] : [])]));
