/**
 * `autocrew doctor` 的 TypeSafe 一项（发布前把关 spec §12、E7）：有没有密钥、来自哪、调一次通不通。
 * 只输出 JSON 结论；密钥值不打印、不写任何地方。没配密钥不算 doctor 失败（语义把关是可选的，没跑成会在 check 里标出）。
 */
import { JevError, makeJevCaller, resolveTypesafeKey } from "../src/modules/publish/review-gate/jev-client.js";

async function main(): Promise<Record<string, unknown>> {
  let source: string | null;
  try { source = (await resolveTypesafeKey()).source; } catch (e) { return { configured: false, source: null, reachable: false, error: e instanceof JevError ? e.reason : String(e) }; }
  if (!source) return { configured: false, source: null, reachable: false };
  try {
    const r = await makeJevCaller()("小红书的封面用 3:4 的", { ping: { type: "noul", instructions: "这句话是否在说封面比例？" } });
    return { configured: true, source, reachable: true, model: r.model, ms: r.ms };
  } catch (e) {
    return { configured: true, source, reachable: false, error: e instanceof JevError ? e.reason : String(e) };
  }
}

console.log(JSON.stringify(await main()));
