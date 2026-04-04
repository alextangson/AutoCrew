// Key points template — numbered list with colored circle numbers

export function render(data: Record<string, unknown>): string {
  const items = (data.items as string[]) ?? [];

  const itemsHtml = items
    .map(
      (item, i) => `
      <div class="point">
        <span class="num">${i + 1}</span>
        <span class="text">${esc(item)}</span>
      </div>`
    )
    .join("\n");

  return `
    <div class="key-points">
      ${itemsHtml}
    </div>
    <style>
      .key-points {
        display: flex;
        flex-direction: column;
        gap: 32px;
      }
      .point {
        display: flex;
        align-items: center;
        gap: 24px;
      }
      .num {
        flex-shrink: 0;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #3b82f6;
        color: #fff;
        font-size: 28px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .text {
        font-size: 32px;
        color: #1e293b;
        line-height: 1.5;
      }
    </style>
  `;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
