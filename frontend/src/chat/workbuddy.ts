/**
 * WorkBuddy 反向接入的前端部分（spec「WorkBuddy：反向接」）：复制给 WorkBuddy 的那句话（创始人认过的措辞）。
 * 与服务端 src/desktop/workbuddy-connect.ts 的 workbuddyPrompt 逐字一致。
 */
import { toast } from "../ui";

export function workbuddyPrompt(title: string, id: string): string {
  return `通过 autocrew MCP 调用 autocrew_desk 打开《${title}》（id: ${id}），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。`;
}

/** 复制按钮：指令本身不依赖是否装了 WorkBuddy（W1），剪贴板失败如实说 */
export async function copyForWorkbuddy(title: string, id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(workbuddyPrompt(title, id));
    toast("已复制，粘到 WorkBuddy 里发出去");
  } catch {
    toast("没能写进剪贴板（浏览器拒绝了），请手动复制");
  }
}
