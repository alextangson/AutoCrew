/**
 * `autocrew doctor` 的 Codex 技能一项：personal-ip-video-loop / publish-content / cover-generator 是否链到本安装。只输出 JSON。
 */
import { checkCodexSkills } from "../src/desktop/host-connect/codex-skills.js";
import { defaultHostEnv } from "../src/desktop/host-connect/env.js";

const env = defaultHostEnv();
console.log(JSON.stringify(checkCodexSkills(env.codexHome, env.skillsRoot)));
