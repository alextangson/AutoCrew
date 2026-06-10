/**
 * =========================================================
 * AutoCrew — background.js (MV3 service worker)
 * 红线声明（PRD §6，runbook 九）：
 *   ✗ 零后台轮询（仅响应用户点击 action 按钮）
 *   ✗ 零自动导航（不操控标签页 URL）
 *   ✗ 零 DOM 写操作（仅读取 content script 返回的行数据）
 *   ✓ 用户触发（每次点击 = 一次完整的 extract → ingest 流程）
 *   ✓ 一次性 sendNativeMessage（不使用 connectNative）
 *
 * MV3 注意事项：
 *   - service worker 可能在消息处理完前进入休眠；此处每个操作都
 *     在一个 async 函数中同步完成，不依赖长连接或 keepAlive。
 *   - content script 在扩展安装/重载前已打开的页面上不存在；
 *     sendMessage 失败时注入一次并重试。Chrome 为每次 executeScript
 *     注入扩展共享的 isolated world：listener 缺席时注入后正常注册，重试成功；
 *     若脚本仍存活，重注入因 const 重声明在解析期失败（被捕获），原 listener 继续服务。
 *   - sendNativeMessage 是一次性调用，符合 ≤1-in-flight 合约。
 * =========================================================
 */

"use strict";

const NATIVE_HOST_ID = "com.autocrew.bridge";
const DOUYIN_ORIGIN = "https://creator.douyin.com/";

// =============================================================
// 通知辅助
// =============================================================

let _notifCounter = 0;

function notify(title, message) {
  _notifCounter++;
  chrome.notifications.create(
    "autocrew-" + _notifCounter,
    {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: title,
      message: message,
    },
    function () {
      // 通知是唯一反馈通道——创建失败必须在 SW console 留痕
      if (chrome.runtime.lastError) {
        console.error("notifications.create 失败:", chrome.runtime.lastError.message);
      }
    }
  );
}

// =============================================================
// 主流程
// =============================================================

/**
 * 进行中守卫：同一时刻只允许一次导入流程（≤1-in-flight）。
 * 注：SW 被回收会重置此标志——它是 UX 防抖，不是正确性契约
 * （native host 侧消息本身幂等）。
 */
let inFlight = false;

chrome.action.onClicked.addListener(function (tab) {
  if (inFlight) {
    notify("AutoCrew：正在导入中", "上一次导入尚未完成，请稍候再点。");
    return;
  }
  inFlight = true;
  handleClick(tab)
    .catch(function (err) {
      notify("AutoCrew 错误", String(err));
    })
    .finally(function () {
      inFlight = false;
    });
});

async function handleClick(tab) {
  // 1. URL 守卫：必须在抖音创作者中心
  if (!tab.url || !tab.url.startsWith(DOUYIN_ORIGIN)) {
    notify(
      "AutoCrew：请先打开作品列表页",
      "请在 creator.douyin.com 的「作品列表」页面点击此按钮。"
    );
    return;
  }

  // 2. 向 content script 请求抽取行数据
  //    页面在扩展安装/重载前已打开 → content script 不存在 →
  //    自愈：用 chrome.scripting 注入一次后重试（activeTab 授权下合法）
  let extractResult;
  try {
    extractResult = await sendMessageToTab(tab.id, { cmd: "extract" });
  } catch (firstErr) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-douyin.js"],
      });
      extractResult = await sendMessageToTab(tab.id, { cmd: "extract" });
    } catch (injectErr) {
      notify(
        "AutoCrew：内容脚本注入失败",
        String(injectErr) + "（请刷新页面后再试）"
      );
      return;
    }
  }

  if (!extractResult || typeof extractResult !== "object") {
    notify("AutoCrew：抽取失败", "content script 返回了意外的响应格式。");
    return;
  }

  const { rows, rowCount, error: extractError } = extractResult;

  if (extractError) {
    notify("AutoCrew：抽取出错", extractError);
    return;
  }

  // 3. rowCount === 0：选择器未命中，提示校准
  if (!rowCount || rowCount === 0) {
    notify(
      "AutoCrew：未读取到数据行（rowCount=0）",
      "请确认当前页面是作品列表页，并按 runbook 九校准 content-douyin.js 顶部的 SELECTOR_CONFIG。"
    );
    return;
  }

  // 4. 发送到 native host（一次性 sendNativeMessage，非 connectNative）
  const bridgeMessage = {
    type: "ingest_rows",
    platform: "douyin",
    rows: rows,
  };

  let response;
  try {
    response = await sendNativeMessageOnce(NATIVE_HOST_ID, bridgeMessage);
  } catch (err) {
    const msg = String(err);
    if (
      msg.includes("Specified native messaging host not found") ||
      msg.includes("not found") ||
      msg.includes("cannot be found")
    ) {
      notify(
        "AutoCrew：native host 未安装",
        "请先运行：npx tsx scripts/install-native-host.mts <扩展ID>"
      );
    } else {
      notify("AutoCrew：native messaging 错误", msg);
    }
    return;
  }

  // 5. 显示导入结果
  if (!response || !response.ok) {
    const errText = (response && response.error) ? response.error : "未知错误";
    notify("AutoCrew：导入失败", errText);
    return;
  }

  const d = response.data || {};
  const total = d.total || rowCount;
  const imported = d.imported !== undefined ? d.imported : total;
  const matched = d.matched !== undefined ? d.matched : "?";
  const historical = d.historical !== undefined ? d.historical : "?";
  const rejected = d.rejected ? d.rejected.length : 0;

  notify(
    "AutoCrew：导入完成",
    "导入 " + imported + " 条（共 " + total + " 行，匹配 " + matched + " / 历史 " + historical + " / 拒收 " + rejected + "）"
  );
}

// =============================================================
// Promise 包装器
// =============================================================

/**
 * chrome.tabs.sendMessage 的 Promise 包装。
 * MV3 中 sendMessage 回调里 chrome.runtime.lastError 必须检查，
 * 否则未捕获错误会产生 console 警告。
 */
function sendMessageToTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, message, function (response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * chrome.runtime.sendNativeMessage 的 Promise 包装。
 * 一次性消息（非 connectNative），符合 ≤1-in-flight 合约。
 * lastError 必须在回调内同步读取（MV3 规范）。
 */
function sendNativeMessageOnce(hostId, message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendNativeMessage(hostId, message, function (response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
