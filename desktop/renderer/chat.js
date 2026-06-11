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
  bubble.textContent = text;
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
  const thinking = appendChatMessage("assistant", "…");

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
      appendChatMessage("assistant", "出错了：" + (res.error || "未知错误"));
    }
    return;
  }

  chatHistory.push({ role: "user", content: message });
  chatHistory.push({ role: "assistant", content: res.data.reply });
  appendChatCards(res.data.cards);
  appendChatMessage("assistant", res.data.reply);
  refreshActivePanel();
}

function initChat() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  function submit() {
    const v = input.value;
    input.value = "";
    sendChat(v);
  }

  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
}

/** Phase C 的 onboarding.js 会接管为首跑流程；日常 = 一句欢迎 */
function bootChatWelcome() {
  appendChatMessage("assistant",
    "我是你的数字编剧。直接说需求，比如：帮我写一条关于 Excel 快捷键的抖音口播。");
}
