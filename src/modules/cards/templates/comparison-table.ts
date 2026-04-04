// Comparison table template — renders a table with pros/cons columns

export function render(data: Record<string, unknown>): string {
  const title = (data.title as string) ?? "";
  const rows = (data.rows as Array<{ name: string; pros: string; cons: string }>) ?? [];

  const rowsHtml = rows
    .map(
      (r) => `
      <tr>
        <td class="name">${esc(r.name)}</td>
        <td class="pros">${esc(r.pros)}</td>
        <td class="cons">${esc(r.cons)}</td>
      </tr>`
    )
    .join("\n");

  return `
    <div class="comparison-table">
      <h1>${esc(title)}</h1>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="pros">Pros</th>
            <th class="cons">Cons</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <style>
      .comparison-table h1 {
        font-size: 48px;
        margin-bottom: 40px;
        color: #1a1a2e;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 28px;
      }
      th, td {
        padding: 20px 24px;
        text-align: left;
        border-bottom: 1px solid #e5e7eb;
      }
      th {
        background: #f8fafc;
        font-weight: 700;
        color: #475569;
        font-size: 24px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      th.pros, td.pros { color: #16a34a; }
      th.cons, td.cons { color: #dc2626; }
      td.name { font-weight: 600; color: #1e293b; }
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
