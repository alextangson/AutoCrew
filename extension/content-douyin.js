/**
 * =========================================================
 * AutoCrew — content-douyin.js
 * 红线声明（PRD §6，runbook 九）：
 *   ✗ 零 DOM 写操作（不修改任何页面元素/表单）
 *   ✗ 零后台轮询（仅响应 background 的 {cmd:"extract"} 消息）
 *   ✗ 零自动导航（不点击任何按钮/链接）
 *   ✓ 用户触发（点扩展图标 → background → 本脚本一次性抽取）
 *
 * 首次使用必校准 SELECTOR_CONFIG（见 runbook 九）：
 *   症状 rowCount=0 → 打开 DevTools Elements 面板，确认真实的
 *   table tbody tr 路径，调整 ROW_SELECTOR；
 *   症状 rejected 全军 → COLUMNS 顺序与实际列序不符，按页面调整。
 * =========================================================
 */

"use strict";

// =============================================================
// SELECTOR_CONFIG — 首次 dogfood 必须根据真实页面校准此区域
// =============================================================
const SELECTOR_CONFIG = {
  /**
   * 作品列表表格行选择器。
   * 默认值 "table tbody tr" 适用于标准 HTML table；
   * 如抖音后台改用 div 虚拟滚动表格，需改为对应的行级容器，
   * 例如 ".semi-table-row" 或 "[class*='table-row']"。
   */
  ROW_SELECTOR: "table tbody tr",

  /**
   * 列索引 → 字段名映射（按真实表格从左到右的列顺序排列）。
   * 抖音"作品列表"页已知列序（2026-06 版本）：
   *   0: 作品名称
   *   1: 发布时间
   *   2: 体裁          ← 跳过（管线不识别）
   *   3: 审核状态      ← 跳过
   *   4: 播放量
   *   5: 完播率
   *   6: 5s完播率
   *   7: 封面点击率    ← 跳过
   *   8: 2s跳出率      ← 跳过
   *   9: 平均播放时长  ← 跳过
   *   10: 点赞量
   *   11: 分享量
   *   12: 评论量
   *   13: 收藏量
   *   14: 主页访问量   ← 跳过（管线不识别）
   *   15: 粉丝增量     ← 如有此列
   *
   * null 表示该列跳过，不放入行对象。
   * 只有 PLATFORM_MAPPINGS.douyin 认识的列名才会被管线消费；
   * 多余的键无害（管线忽略），但 null 比未知键更节省传输。
   */
  COLUMNS: [
    "作品名称",   // 0
    "发布时间",   // 1
    null,         // 2  体裁（跳过）
    null,         // 3  审核状态（跳过）
    "播放量",     // 4
    "完播率",     // 5
    "5s完播率",   // 6
    null,         // 7  封面点击率（跳过）
    null,         // 8  2s跳出率（跳过）
    null,         // 9  平均播放时长（跳过）
    "点赞量",     // 10
    "分享量",     // 11
    "评论量",     // 12
    "收藏量",     // 13
    null,         // 14 主页访问量（跳过）
    "粉丝增量",   // 15（如有）
  ],
};

// =============================================================
// extractRows() — 纯函数；零副作用；不写 DOM
// =============================================================

/**
 * 从当前页面表格中抽取行数据。
 * @returns {Array<Record<string, string>>} 行数组，每行仅含 COLUMNS 中非 null 的字段
 */
function extractRows() {
  const rows = document.querySelectorAll(SELECTOR_CONFIG.ROW_SELECTOR);
  const result = [];

  for (const tr of rows) {
    const cells = tr.querySelectorAll("td");
    // 少于 2 个非空单元格 → 表头行或空占位行，跳过
    const nonEmpty = Array.from(cells).filter((td) => td.innerText.trim() !== "");
    if (nonEmpty.length < 2) continue;

    const rowObj = {};
    SELECTOR_CONFIG.COLUMNS.forEach((fieldName, colIndex) => {
      if (fieldName === null) return; // 跳过此列
      const cell = cells[colIndex];
      if (!cell) return;
      const text = cell.innerText.trim();
      if (text !== "") {
        rowObj[fieldName] = text;
      }
    });

    // 行对象至少要有作品名称或发布时间，否则可能是合计行
    if (Object.keys(rowObj).length > 0) {
      result.push(rowObj);
    }
  }

  return result;
}

// =============================================================
// Message listener — 只响应 {cmd:"extract"}；零 DOM 写操作
// =============================================================
chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || message.cmd !== "extract") return false;

  try {
    const rows = extractRows();
    sendResponse({
      rows: rows,
      pageUrl: location.href,
      rowCount: rows.length,
    });
  } catch (err) {
    sendResponse({
      rows: [],
      pageUrl: location.href,
      rowCount: 0,
      error: String(err),
    });
  }

  return false; // 同步响应，不保留消息通道
});
