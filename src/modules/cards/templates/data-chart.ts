// Data chart template — horizontal bar chart

export function render(data: Record<string, unknown>): string {
  const title = (data.title as string) ?? "";
  const items = (data.items as Array<{ label: string; value: number }>) ?? [];
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  const barsHtml = items
    .map((item) => {
      const pct = Math.round((item.value / maxValue) * 100);
      return `
      <div class="bar-row">
        <span class="label">${esc(item.label)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="value">${item.value}</span>
      </div>`;
    })
    .join("\n");

  return `
    <div class="data-chart">
      <h1>${esc(title)}</h1>
      ${barsHtml}
    </div>
    <style>
      .data-chart h1 {
        font-size: 48px;
        margin-bottom: 40px;
        color: #1a1a2e;
      }
      .bar-row {
        display: flex;
        align-items: center;
        gap: 20px;
        margin-bottom: 24px;
      }
      .label {
        width: 180px;
        flex-shrink: 0;
        font-size: 26px;
        font-weight: 600;
        color: #334155;
        text-align: right;
      }
      .bar-track {
        flex: 1;
        height: 40px;
        background: #f1f5f9;
        border-radius: 8px;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        background: #3b82f6;
        border-radius: 8px;
        transition: width 0.3s;
      }
      .value {
        width: 80px;
        font-size: 26px;
        font-weight: 700;
        color: #3b82f6;
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
