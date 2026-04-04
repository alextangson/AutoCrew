// Flow chart template — horizontal steps with arrows

export function render(data: Record<string, unknown>): string {
  const steps = (data.steps as string[]) ?? [];

  const stepsHtml = steps
    .map((step, i) => {
      const arrow = i < steps.length - 1 ? '<span class="arrow">\u2192</span>' : "";
      return `<span class="step">${esc(step)}</span>${arrow}`;
    })
    .join("\n");

  return `
    <div class="flow-chart">
      ${stepsHtml}
    </div>
    <style>
      .flow-chart {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 24px;
      }
      .step {
        background: #eff6ff;
        border: 2px solid #3b82f6;
        border-radius: 16px;
        padding: 24px 36px;
        font-size: 28px;
        font-weight: 600;
        color: #1e40af;
      }
      .arrow {
        font-size: 40px;
        color: #3b82f6;
        font-weight: 700;
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
