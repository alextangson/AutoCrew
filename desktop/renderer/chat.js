/**
 * Chat stream — PRD §7.3 驱动层。会话连续性由 conversation_id 承担（S2.8 主进程持久化），
 * renderer 不再持有 history。依赖 dom.js + cards.js。
 */

let activeConversationId = null;
let chatBusy = false;

const CREW_BADGE = { scout: "侦", writer: "编", review: "审", analyst: "析" };
let progressSteps = [];
let activeThinking = null;

function appendChatMessage(role, text) {
  exitHeroMode();
  const stream = document.getElementById("chat-stream");
  const msg = h("div", { class: "chat-msg chat-" + role });
  const bubble = h("div", { class: "chat-bubble" });
  if (role === "assistant" && typeof renderMarkdown === "function") {
    bubble.appendChild(renderMarkdown(text));
  } else {
    bubble.textContent = text;
  }
  msg.appendChild(bubble);
  stream.appendChild(msg);
  stream.scrollTop = stream.scrollHeight;
  return msg;
}

function appendCardToStream(cardEl) {
  exitHeroMode();
  const stream = document.getElementById("chat-stream");
  const wrap = h("div", { class: "chat-msg chat-assistant" });
  wrap.appendChild(cardEl);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;
}

function appendChatCards(cards) {
  if (!cards) return;
  for (const card of cards) {
    let el;
    try {
      el = renderCard(card);
    } catch {
      // 持久化卡片可能畸形（历史回放）：降级为 JSON 展示，不中断整条回放
      const pre = h("pre", { class: "card-body" });
      pre.textContent = JSON.stringify(card.data, null, 2);
      el = h("div", { class: "chat-card" }, pre);
    }
    appendCardToStream(el);
  }
}

function exitHeroMode() {
  document.getElementById("main-area").classList.remove("hero-mode");
}

/** 新任务：清流、回 hero 空态。首条消息发出才建会话（零仪式感）。 */
function newTask() {
  if (chatBusy) { showToast("正在干活，稍等片刻再开新任务"); return; }
  activeConversationId = null;
  document.getElementById("chat-stream").innerHTML = "";
  document.getElementById("main-area").classList.add("hero-mode");
  if (typeof refreshConversationList === "function") refreshConversationList();
  renderHeroChips();
  document.getElementById("chat-input").focus();
}

/** 任务历史回放：文字 + 卡片按发送时顺序重渲染（卡片在回复文字前，与实时一致） */
async function loadConversation(id) {
  if (chatBusy) { showToast("正在干活，稍等片刻再切换任务"); return; }
  const res = await safeInvoke(window.autocrew.conversationsGet, { id });
  if (!res.ok) {
    showToast(res.error || "无法打开该任务");
    if (typeof refreshConversationList === "function") refreshConversationList();
    return;
  }
  activeConversationId = id;
  document.getElementById("chat-stream").innerHTML = "";
  exitHeroMode();
  const messages = (res.data && res.data.messages) || [];
  for (const m of messages) {
    if (m.role === "assistant") {
      appendChatCards(m.cards);
      appendChatMessage("assistant", m.content);
    } else {
      appendChatMessage("user", m.content);
    }
  }
  if (typeof refreshConversationList === "function") refreshConversationList();
}

async function sendChat(text) {
  if (chatBusy) return;
  const message = (text || "").trim();
  if (!message) return;

  chatBusy = true;
  const sendBtn = document.getElementById("chat-send");
  sendBtn.disabled = true;
  appendChatMessage("user", message);
  progressSteps = [];
  const thinking = appendChatMessage("assistant", "正在干活…（写稿约需 30-60 秒）");
  activeThinking = thinking;

  const payload = { message };
  if (activeConversationId) payload.conversation_id = activeConversationId;
  const res = await safeInvoke(window.autocrew.chatTurn, payload);

  thinking.remove();
  activeThinking = null;
  chatBusy = false;
  sendBtn.disabled = false;

  if (!res.ok) {
    if (res.needsSetup) {
      const msg = appendChatMessage("assistant",
        "引擎还没配置 model provider。打开侧边栏「设置」，在开发者区填入 API key 即可开聊。");
      const btn = h("button", { class: "btn-mini" }, "打开设置");
      btn.addEventListener("click", () => openDrawer("settings"));
      msg.appendChild(btn);
    } else {
      appendChatMessage("assistant", "出错了：" + (res.error || "未知错误") + "。可以直接重发，或到侧边栏「设置」检查引擎配置。");
    }
    return;
  }

  if (res.data.conversationId) activeConversationId = res.data.conversationId;
  appendChatCards(res.data.cards);
  appendChatMessage("assistant", res.data.reply);
  refreshActiveDrawer();
  if (typeof refreshConversationList === "function") refreshConversationList();
}

function initChat() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  function submit() {
    if (chatBusy) return; // busy 时不取走输入，避免静默丢失
    const v = input.value;
    if (!v.trim()) return;
    input.value = "";
    sendChat(v);
  }

  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // 中文输入法组合中——Enter 是选词，不是发送
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
}

/** 状态时间线：完成步 ✓ 累积，当前步带角色徽（PRD §7.3 可见工作流） */
function renderProgressBubble() {
  if (!activeThinking) return;
  const bubble = activeThinking.querySelector(".chat-bubble");
  if (!bubble) return;
  bubble.textContent = "";
  const list = h("div", { class: "chat-progress" });
  progressSteps.forEach((step) => {
    const row = h("div", { class: step.done ? "progress-step progress-done" : "progress-step progress-active" });
    if (step.role && CREW_BADGE[step.role]) {
      row.appendChild(h("span", { class: "progress-badge byline-badge byline-badge-" + step.role }, CREW_BADGE[step.role]));
    }
    row.appendChild(h("span", {}, step.label + (step.done ? " ✓" : "…")));
    list.appendChild(row);
  });
  if (progressSteps.length === 0) {
    list.appendChild(h("div", { class: "progress-step progress-active" }, "正在干活…（写稿约需 30-60 秒）"));
  }
  bubble.appendChild(list);
}

function handleChatProgress(e) {
  if (!activeThinking || !e || typeof e.label !== "string") return;
  if (e.phase === "start") {
    progressSteps.push({ role: e.role, label: e.label, done: false });
  } else if (e.phase === "end") {
    const open = [...progressSteps].reverse().find((s) => !s.done && s.label === e.label);
    if (open) open.done = true;
  }
  renderProgressBubble();
}

if (window.autocrew && typeof window.autocrew.onChatProgress === "function") {
  window.autocrew.onChatProgress(handleChatProgress);
}

/** Hero 上下文 chip：赛道 + 知识库状态（只读，点击开对应抽屉）。
 *  先并发取数再一次性写 DOM：并发调用不重复出 chip。 */
async function renderHeroChips() {
  const wrap = document.getElementById("hero-chips");
  if (!wrap) return;
  const [status, kb] = await Promise.all([
    safeInvoke(window.autocrew.onboardingStatus),
    safeInvoke(window.autocrew.knowledgeStatus),
  ]);

  const industry = status.ok && status.data && status.data.industry ? status.data.industry : null;
  const indChip = h("button", { class: "hero-chip", title: "点击打开侦察员面板调整定位" },
    "赛道：" + (industry || "未设置"));
  indChip.addEventListener("click", () => openDrawer("scout"));

  const kbReady = kb.ok && kb.data && kb.data.count > 0;
  const kbChip = h("button", { class: "hero-chip", title: "知识库详情在设置中查看" },
    "知识库：" + (kbReady ? "已就绪" : "未导入"));
  kbChip.addEventListener("click", () => openDrawer("settings"));

  wrap.innerHTML = "";
  wrap.appendChild(indChip);
  wrap.appendChild(kbChip);
}
