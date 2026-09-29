/** 对话改名（v1.1 U6）：空名不保存；截 40 字在服务端；两个标签页同时改后写覆盖 */
import { invoke } from "../transport";
import { openDialog, toast } from "../ui";

export async function renameConversationDialog(id: string, current: string): Promise<boolean> {
  const v = await openDialog({ title: "改对话标题", body: "最多 40 字；留空不保存。", fields: [{ key: "title", label: "标题", placeholder: current }], confirmLabel: "保存" });
  if (!v) return false;
  if (!v.title.trim()) { toast("标题为空，保留原名"); return false; }
  const r = await invoke("conversations:rename", { id, title: v.title });
  if (!r.ok) { toast(r.error ?? "改名失败"); return false; }
  return true;
}
