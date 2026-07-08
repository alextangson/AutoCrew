/**
 * Shared DOM helpers — 必须在 cards.js / chat.js / app.js 之前加载。
 * 用户内容一律 textContent，禁 innerHTML 注入。
 */

// ── DOM helper ────────────────────────────────────────────────────────────────

/**
 * h(tag, attrs?, ...children) — minimal DOM builder.
 * attrs: plain object of attribute key→value (class, id, type, etc.)
 * children: strings (→ text nodes) or Element nodes.
 */
function h(tag, attrsOrChild, ...rest) {
  const el = document.createElement(tag);
  let children = rest;

  if (attrsOrChild !== null && attrsOrChild !== undefined) {
    if (typeof attrsOrChild === "string" || attrsOrChild instanceof Node) {
      children = [attrsOrChild, ...rest];
    } else if (typeof attrsOrChild === "object" && !Array.isArray(attrsOrChild)) {
      for (const [k, v] of Object.entries(attrsOrChild)) {
        if (k === "class") el.className = v;
        else if (k === "style") el.style.cssText = v;
        else el.setAttribute(k, v);
      }
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number") {
      el.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }
  return el;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap an IPC invoke: a rejected invoke (main process crash mid-call) becomes
 * the standard {ok:false} shape so it flows into the toast path instead of
 * leaving a button disabled forever.
 */
async function safeInvoke(fn, payload) {
  try {
    return await fn(payload);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.textContent = loading ? (label || "处理中...") : btn.dataset.label;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/**
 * 平台目录——单一事实源（IA v4.2:平台全集 = 能力目录,profile.platforms = 用户席位）。
 * group: cn 可生成 | en 席位未开通(裁决 F 排队); gen: 是否已支持原生生成。
 */
const PLATFORM_CATALOG = [
  { id: "wechat_mp", label: "公众号", group: "cn", gen: true },
  { id: "douyin", label: "抖音", group: "cn", gen: true },
  { id: "xiaohongshu", label: "小红书", group: "cn", gen: true },
  { id: "wechat_video", label: "视频号", group: "cn", gen: true },
  { id: "bilibili", label: "B站", group: "cn", gen: true },
  { id: "twitter", label: "Twitter", group: "en", gen: false },
  { id: "instagram", label: "Instagram", group: "en", gen: false },
  { id: "reddit", label: "Reddit", group: "en", gen: false },
];
const PLATFORM_BY_ID = Object.fromEntries(PLATFORM_CATALOG.map((p) => [p.id, p]));

function platformLabel(p) {
  return (PLATFORM_BY_ID[p] && PLATFORM_BY_ID[p].label) || p || "—";
}

/** 当前用户席位（app 启动缓存,profile.platforms;空 → 默认公众号 P0）。第一席位 = 派活默认平台。 */
function userSeats() {
  const s = (window.__seats && window.__seats.length) ? window.__seats : ["wechat_mp"];
  return s.filter((id) => PLATFORM_BY_ID[id]); // 防脏数据
}
function defaultSeat() {
  return userSeats()[0] || "wechat_mp";
}

function statusLabel(s) {
  const m = {
    draft_ready: "草稿就绪", drafting: "草稿中", reviewing: "审核中",
    approved: "已审批", publish_ready: "待发布", published: "已发布",
    archived: "已归档", topic_saved: "选题已存", cover_pending: "等待封面",
    publishing: "发布中", revision: "修改中",
  };
  return m[s] || s || "—";
}
