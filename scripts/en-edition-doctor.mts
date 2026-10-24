/**
 * `autocrew doctor` 的英文版一项：ElevenLabs 密钥 / 声音 id / 字幕脚本 / 字体。只输出 JSON 结论；密钥值不打印。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enDoctorHints, enEditionDoctor } from "../src/modules/voice/doctor.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d = await enEditionDoctor(root);
console.log(JSON.stringify({ ...d, hints: enDoctorHints(d) }));
