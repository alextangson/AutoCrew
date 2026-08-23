import {
  listIdentityLibrary,
  removeIdentityAsset,
  setGeneratedPortraitSelected,
  setPrimaryIdentitySource,
  uploadIdentitySource,
  type IdentityAssetKind,
} from "../modules/cover/identity-library.js";
import { generateIdentityPortraitCandidates } from "../modules/cover/identity-generator.js";
import { emitEngineEvent } from "./event-hub.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

export interface StartedIdentityPortraitJob {
  response: HandlerResult;
  completion: Promise<void>;
}

function dataDirOf(payload: Payload): string | undefined {
  return (payload._dataDir as string) || undefined;
}

export function startIdentityPortraitJob(payload: Payload): StartedIdentityPortraitJob {
  const dataDir = dataDirOf(payload);
  const runId = `run-portrait-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "publisher", kind, label, contentId: "cover-identity", runId }, dataDir).catch(
      () => {},
    );
  emit("work", "正在基于真实照片生成 3 张个人形象备选…");
  const completion = (async () => {
    try {
      const result = await generateIdentityPortraitCandidates(dataDir);
      if (result.generated > 0) {
        emit(
          "run_done",
          `个人形象备选已生成 ${result.generated}/3 张${result.failed ? `；${result.failed} 张失败，可稍后重试` : ""}`,
        );
      } else {
        emit("run_failed", `个人形象生成失败：${result.errors[0] ?? "生图服务未返回可用人物"}`);
      }
    } catch (err) {
      emit("run_failed", `个人形象生成失败：${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    }
  })();
  return { response: { ok: true, pending: true, runId }, completion };
}

export async function coverIdentityHandler(payload: Payload): Promise<HandlerResult> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const action = typeof payload.action === "string" ? payload.action : "";
  const dataDir = dataDirOf(payload);
  try {
    if (action === "get") return { ok: true, data: await listIdentityLibrary(dataDir) };
    if (action === "upload") {
      const dataBase64 = typeof payload.data_base64 === "string" ? payload.data_base64 : "";
      return { ok: true, data: await uploadIdentitySource(dataBase64, dataDir) };
    }
    if (action === "set_primary") {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      return { ok: true, data: await setPrimaryIdentitySource(filename, dataDir) };
    }
    if (action === "select_generated") {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      if (typeof payload.selected !== "boolean") return { ok: false, error: "selected 必须是 boolean" };
      return { ok: true, data: await setGeneratedPortraitSelected(filename, payload.selected, dataDir) };
    }
    if (action === "remove") {
      const kind = payload.kind as IdentityAssetKind;
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      return { ok: true, data: await removeIdentityAsset(kind, filename, dataDir) };
    }
    if (action === "generate") return startIdentityPortraitJob(payload).response;
    return { ok: false, error: `未知个人形象操作：${action || "未提供"}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
