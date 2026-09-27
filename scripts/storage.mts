import { applyPendingStorage, previewStorage, queueStorage, storageStatus, type StorageRequest } from "../src/storage/library-manager.js";
import { cancelStorageSettings } from "../src/desktop/settings-storage.js";
const [action, target] = process.argv.slice(2);
try {
  if (action === "status") console.log(JSON.stringify(await storageStatus(), null, 2));
  else if (action === "cancel") { await cancelStorageSettings(); console.log("已取消待切换，现有资料位置保持不变。"); }
  else if (action === "apply") {
    const plan = await applyPendingStorage((copied, total) => { if (copied % 100 === 0 || copied === total) console.error(`资料库复制与校验：${copied}/${total}`); });
    if (plan) console.log(`资料库已切换：${plan.target}；原始文件已保留。`);
  } else if (action === "preview") {
    console.log(JSON.stringify(await previewStorage({ action: "migrate", target }), null, 2));
  } else if (["create", "open", "migrate"].includes(action) && target) {
    const plan = await queueStorage({ action: action as StorageRequest["action"], target });
    console.log(JSON.stringify(plan, null, 2));
    console.log("已准备切换。停止并重启 AutoCrew 后执行；失败时保持原资料位置。");
  } else throw new Error("用法：autocrew storage status|cancel|preview|create|open|migrate <完整路径>");
} catch (err) { console.error((err as Error).message); process.exitCode = 1; }
