/**
 * Chat stream — PRD §7.3 驱动层。history 截到最近 12 条（风格/档案上下文
 * 由引擎自己注入，对话历史只承担会话连续性）。依赖 dom.js + cards.js。
 */

const chatHistory = [];
let chatBusy = false;

function appendChatMessage(role, text) {
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
  const stream = document.getElementById("chat-stream");
  const wrap = h("div", { class: "chat-msg chat-assistant" });
  wrap.appendChild(cardEl);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;
}

function appendChatCards(cards) {
  if (!cards) return;
  for (const card of cards) appendCardToStream(renderCard(card));
}

async function sendChat(text) {
  if (chatBusy) return;
  const message = (text || "").trim();
  if (!message) return;

  chatBusy = true;
  const sendBtn = document.getElementById("chat-send");
  sendBtn.disabled = true;
  appendChatMessage("user", message);
  const thinking = appendChatMessage("assistant", "正在干活…（写稿约需 30-60 秒）");

  const res = await safeInvoke(window.autocrew.chatTurn, {
    message,
    history: chatHistory.slice(-12),
  });

  thinking.remove();
  chatBusy = false;
  sendBtn.disabled = false;

  if (!res.ok) {
    if (res.needsSetup) {
      const msg = appendChatMessage("assistant",
        "引擎还没配置 model provider。打开右侧「设置」，在开发者区填入 API key 即可开聊。");
      const btn = h("button", { class: "btn-mini" }, "打开设置");
      btn.addEventListener("click", () => switchPanel("settings"));
      msg.appendChild(btn);
    } else {
      appendChatMessage("assistant", "出错了：" + (res.error || "未知错误") + "。可以直接重发，或到右侧「设置」检查引擎配置。");
    }
    return;
  }

  chatHistory.push({ role: "user", content: message });
  chatHistory.push({ role: "assistant", content: res.data.reply || "" });
  appendChatCards(res.data.cards);
  appendChatMessage("assistant", res.data.reply);
  refreshActivePanel();
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

/** Phase C 的 onboarding.js 会接管为首跑流程；日常 = 一句欢迎 */
function bootChatWelcome() {
  appendChatMessage("assistant",
    "编辑部就位。直接说需求，比如：帮我写一条关于 Excel 快捷键的抖音口播。");
}
