/**
 * 存储类故障的统一口径（P6 §13.4-A）。
 *
 * 资料库写不进去（盘不支持硬链接、没权限、满了、版本锁残留、资料库卸载/失去写入权）
 * 不是这一步的业务错误，宿主换个参数重试也没用。回 `storage_unavailable`，
 * 附原始错误，让宿主停下报告创作者——绝不能把稿子另存成库外文件继续推进。
 */

const STORAGE_CODES = new Set([
  "ENOTSUP", "EOPNOTSUPP", "EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS",
  "EWRITELOCKED", "EIO", "ENOTCONN", "ESTALE", "EHOSTDOWN",
]);
/** 没带 code、只在消息里带出存储故障的包装错误（例如 `ENOTSUP: operation not supported …`） */
const STORAGE_MESSAGE = /\b(ENOTSUP|EOPNOTSUPP|EACCES|ENOSPC|EDQUOT|EROFS|EWRITELOCKED|ENOTCONN|ESTALE)\b|library_writer_lost/;

export const STORAGE_NEXT_ACTION =
  "停下，把 error 原文报告给创作者，等资料库恢复后再重试这一步；不得把稿子或结果写成资料库之外的文件继续推进。";

function isStorageError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && STORAGE_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : "";
  if (STORAGE_MESSAGE.test(message)) return true;
  return isStorageError((err as { cause?: unknown }).cause, depth + 1);
}

export type StorageFailure = {
  ok: false;
  code: "storage_unavailable";
  error: string;
  next_action: string;
};

/** 是存储类故障就给出统一失败回执，否则 null（交回调用方原有的错误口径） */
export function storageFailure(err: unknown): StorageFailure | null {
  if (!isStorageError(err)) return null;
  return {
    ok: false,
    code: "storage_unavailable",
    error: err instanceof Error ? err.message : String(err),
    next_action: STORAGE_NEXT_ACTION,
  };
}
