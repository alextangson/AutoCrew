# Web UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild AutoCrew's web UI from traditional SaaS layout to a modern Linear+Notion style app with top nav, kanban board, and split-pane content editor.

**Architecture:** Replace sidebar layout with top bar navigation. 4 pages: Discover (topic cards), Content (kanban/list), Editor (full-screen 3-column), Publish (platform status). New dependencies: zustand (editor state), @dnd-kit/core (kanban drag), cmdk (command palette).

**Tech Stack:** React 19, React Router 7, React Query 5, zustand, @dnd-kit/core, cmdk, plain CSS with variables

---

### Task 1: Install Dependencies and Update Layout Shell

**Files:**
- Modify: `web/package.json`
- Rewrite: `web/src/App.tsx`
- Modify: `web/src/index.css`

**Step 1: Install new dependencies**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm install zustand @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities cmdk`

**Step 2: Rewrite App.tsx — top bar nav replacing sidebar**

```tsx
// web/src/App.tsx
import { Routes, Route, NavLink } from 'react-router-dom';
import Discover from './pages/Discover';
import ContentBoard from './pages/ContentBoard';
import Editor from './pages/Editor';
import Publish from './pages/Publish';
import Settings from './pages/Settings';
import CommandPalette from './components/CommandPalette';

const navItems = [
  { to: '/', label: '发现' },
  { to: '/content', label: '内容' },
  { to: '/publish', label: '发布' },
];

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-brand">AutoCrew</span>
        <nav className="topbar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `topbar-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <CommandPalette />
          <NavLink to="/settings" className="topbar-link">
            设置
          </NavLink>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Discover />} />
          <Route path="/content" element={<ContentBoard />} />
          <Route path="/content/:contentId" element={<Editor />} />
          <Route path="/publish" element={<Publish />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
```

**Step 3: Update index.css — replace sidebar layout with top bar**

Replace the entire layout section and add top bar styles. Keep existing utility classes (cards, badges, buttons, tables). Remove `.layout`, `.sidebar`, `.sidebar-brand`, `.nav-link`, `.main-content`. Add:

```css
/* Layout — Top bar */
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
  gap: 4px;
}

.topbar-brand {
  font-size: 1rem;
  font-weight: 700;
  color: var(--primary);
  margin-right: 24px;
  letter-spacing: 0.3px;
}

.topbar-nav {
  display: flex;
  gap: 2px;
}

.topbar-link {
  padding: 6px 12px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.875rem;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}

.topbar-link:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}

.topbar-link.active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.app-main {
  flex: 1;
  overflow: auto;
}

/* Page container */
.page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.page-full {
  height: calc(100vh - 48px);
  overflow: hidden;
}
```

**Step 4: Create placeholder pages so the app compiles**

Create minimal placeholder files that just return a div with the page name:
- `web/src/pages/Discover.tsx`
- `web/src/pages/ContentBoard.tsx`
- `web/src/pages/Editor.tsx`
- `web/src/pages/Publish.tsx`
- `web/src/pages/Settings.tsx`
- `web/src/components/CommandPalette.tsx`

Each placeholder:
```tsx
export default function PageName() {
  return <div className="page"><h1>页面名</h1></div>;
}
```

CommandPalette placeholder:
```tsx
export default function CommandPalette() {
  return <button className="topbar-link">Cmd+K</button>;
}
```

**Step 5: Verify app compiles and runs**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run build`
Expected: Build succeeds with no errors

**Step 6: Commit**

```bash
git add web/
git commit -m "feat(web): replace sidebar with top bar navigation, new page structure"
```

---

### Task 2: Discover Page (Topic Cards)

**Files:**
- Rewrite: `web/src/pages/Discover.tsx`
- Modify: `web/src/index.css` (add topic card styles)
- Modify: `web/src/api.ts` (add createContentFromTopic)

**Step 1: Add API function**

Add to `web/src/api.ts`:
```typescript
export async function createContentFromTopic(topicId: string) {
  return request<{ id: string }>('/contents', {
    method: 'POST',
    body: JSON.stringify({ topicId }),
  });
}
```

**Step 2: Add CSS for topic cards**

Add to `web/src/index.css`:
```css
/* Topic cards */
.topic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.topic-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s;
  cursor: default;
}

.topic-card:hover {
  border-color: var(--text-muted);
}

.topic-card-title {
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.5;
}

.topic-card-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.topic-card-action {
  margin-top: auto;
}

.section-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}
```

**Step 3: Implement Discover page**

```tsx
// web/src/pages/Discover.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchTopics, executeTool, createContentFromTopic } from '../api';

interface Topic {
  id: string;
  title: string;
  score?: number;
  source?: string;
}

export default function Discover() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: topics = [] } = useQuery<Topic[]>({
    queryKey: ['topics'],
    queryFn: fetchTopics as () => Promise<Topic[]>,
  });

  const researchMut = useMutation({
    mutationFn: () => executeTool('autocrew_research', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topics'] }),
  });

  const createMut = useMutation({
    mutationFn: (topicId: string) => createContentFromTopic(topicId),
    onSuccess: (data) => {
      navigate(`/content/${(data as { id: string }).id}`);
    },
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>发现</h1>
        <button
          className="btn btn-primary"
          onClick={() => researchMut.mutate()}
          disabled={researchMut.isPending}
        >
          {researchMut.isPending ? '搜索中...' : '刷新选题'}
        </button>
      </div>

      {(topics as Topic[]).length === 0 ? (
        <p className="muted">暂无选题，点击「刷新选题」开始</p>
      ) : (
        <>
          <div className="section-label">热门选题</div>
          <div className="topic-grid">
            {(topics as Topic[]).map((t) => (
              <div key={t.id} className="topic-card">
                <div className="topic-card-title">{t.title}</div>
                <div className="topic-card-meta">
                  {t.score != null && <span className="score-badge">{t.score.toFixed(0)}</span>}
                  {t.source && <span>{t.source}</span>}
                </div>
                <div className="topic-card-action">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => createMut.mutate(t.id)}
                    disabled={createMut.isPending}
                  >
                    开始创作
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

**Step 4: Verify**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add web/
git commit -m "feat(web): add Discover page with topic cards"
```

---

### Task 3: Content Board (Kanban + List)

**Files:**
- Rewrite: `web/src/pages/ContentBoard.tsx`
- Create: `web/src/components/KanbanColumn.tsx`
- Create: `web/src/components/ContentCard.tsx`
- Modify: `web/src/index.css` (kanban styles)
- Modify: `web/src/api.ts` (add updateContentStatus)

**Step 1: Add API function**

Add to `web/src/api.ts`:
```typescript
export async function updateContentStatus(id: string, status: string) {
  return request<unknown>(`/contents/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}
```

**Step 2: Add kanban CSS**

Add to `web/src/index.css`:
```css
/* Kanban */
.board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.view-toggle {
  display: flex;
  gap: 2px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  padding: 2px;
}

.view-toggle button {
  padding: 4px 12px;
  font-size: 0.8rem;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.view-toggle button.active {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.kanban {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  align-items: start;
}

.kanban-column {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  padding: 12px;
  min-height: 200px;
}

.kanban-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 0 4px;
}

.kanban-column-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.kanban-column-count {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.kanban-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.content-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}

.content-card:hover {
  border-color: var(--text-muted);
  transform: translateY(-1px);
}

.content-card-title {
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 8px;
  line-height: 1.4;
}

.content-card-formats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 0.75rem;
}

.format-tag {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
}

.format-tag.done {
  background: rgba(63, 185, 80, 0.12);
  color: var(--green);
}

.format-tag.active {
  background: rgba(88, 166, 255, 0.12);
  color: var(--blue);
}

.format-tag.failed {
  background: rgba(248, 81, 73, 0.12);
  color: var(--red);
}
```

**Step 3: Create ContentCard component**

```tsx
// web/src/components/ContentCard.tsx
import { useNavigate } from 'react-router-dom';

interface Format {
  type: string;
  label: string;
  status: 'done' | 'active' | 'pending' | 'failed';
}

interface Props {
  id: string;
  title: string;
  formats: Format[];
}

export default function ContentCard({ id, title, formats }: Props) {
  const navigate = useNavigate();

  return (
    <div className="content-card" onClick={() => navigate(`/content/${id}`)}>
      <div className="content-card-title">{title}</div>
      {formats.length > 0 && (
        <div className="content-card-formats">
          {formats.map((f) => (
            <span key={f.type} className={`format-tag ${f.status}`}>
              {f.label} {f.status === 'done' ? '完成' : f.status === 'active' ? '生成中' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Create KanbanColumn component**

```tsx
// web/src/components/KanbanColumn.tsx
import ContentCard from './ContentCard';

interface ContentItem {
  id: string;
  title: string;
  formats: { type: string; label: string; status: 'done' | 'active' | 'pending' | 'failed' }[];
}

interface Props {
  title: string;
  items: ContentItem[];
}

export default function KanbanColumn({ title, items }: Props) {
  return (
    <div className="kanban-column">
      <div className="kanban-column-header">
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">{items.length}</span>
      </div>
      <div className="kanban-cards">
        {items.map((item) => (
          <ContentCard key={item.id} {...item} />
        ))}
      </div>
    </div>
  );
}
```

**Step 5: Implement ContentBoard page**

```tsx
// web/src/pages/ContentBoard.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchContents } from '../api';
import KanbanColumn from '../components/KanbanColumn';

interface ContentItem {
  id: string;
  title: string;
  status: string;
  platform?: string;
  createdAt?: string;
}

const COLUMNS = [
  { key: 'topic', label: '选题' },
  { key: 'drafting', label: '创作中' },
  { key: 'ready', label: '就绪' },
  { key: 'published', label: '已发布' },
];

function mapFormats(item: ContentItem) {
  // Placeholder — will be enriched when backend supports multi-format
  if (item.platform) {
    return [{ type: item.platform, label: item.platform, status: 'done' as const }];
  }
  return [];
}

export default function ContentBoard() {
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const navigate = useNavigate();

  const { data: contents = [] } = useQuery<ContentItem[]>({
    queryKey: ['contents'],
    queryFn: fetchContents as () => Promise<ContentItem[]>,
  });

  const grouped = COLUMNS.map((col) => ({
    ...col,
    items: (contents as ContentItem[])
      .filter((c) => c.status === col.key)
      .map((c) => ({ id: c.id, title: c.title, formats: mapFormats(c) })),
  }));

  return (
    <div className="page">
      <div className="board-header">
        <h1>内容</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div className="view-toggle">
            <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
              看板
            </button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              列表
            </button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/')}>
            + 新建
          </button>
        </div>
      </div>

      {view === 'kanban' ? (
        <div className="kanban">
          {grouped.map((col) => (
            <KanbanColumn key={col.key} title={col.label} items={col.items} />
          ))}
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>格式</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {(contents as ContentItem[]).length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>暂无内容</td>
                </tr>
              )}
              {(contents as ContentItem[]).map((item) => (
                <tr key={item.id} onClick={() => navigate(`/content/${item.id}`)} style={{ cursor: 'pointer' }}>
                  <td>{item.title}</td>
                  <td><span className="badge badge-blue">{item.status}</span></td>
                  <td>{item.platform || '-'}</td>
                  <td>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

**Step 6: Verify**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run build`

**Step 7: Commit**

```bash
git add web/
git commit -m "feat(web): add Content Board with kanban and list views"
```

---

### Task 4: Full-Screen Editor (Core Page)

**Files:**
- Rewrite: `web/src/pages/Editor.tsx`
- Create: `web/src/components/FormatSidebar.tsx`
- Create: `web/src/components/ScriptEditor.tsx`
- Create: `web/src/components/PreviewPanel.tsx`
- Modify: `web/src/index.css` (editor styles)

**Step 1: Add editor CSS**

Add to `web/src/index.css`:
```css
/* Editor — full screen 3-column */
.editor {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.editor-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.editor-back {
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.875rem;
}

.editor-back:hover {
  color: var(--text);
}

.editor-title {
  font-size: 1rem;
  font-weight: 600;
}

.editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Left: format sidebar */
.format-sidebar {
  width: 200px;
  border-right: 1px solid var(--border);
  padding: 16px;
  overflow-y: auto;
  flex-shrink: 0;
}

.format-item {
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.15s;
}

.format-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.format-item.selected {
  background: rgba(255, 255, 255, 0.06);
}

.format-item-label {
  font-weight: 500;
}

.format-item-status {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 2px;
}

.format-settings {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.format-setting {
  margin-bottom: 12px;
}

.format-setting-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.format-setting-value {
  font-size: 0.8rem;
}

.format-setting select {
  width: 100%;
  padding: 4px 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 0.8rem;
}

/* Center: script editor */
.script-panel {
  flex: 1;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.script-panel-header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 0.8rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

.script-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.script-paragraph {
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  border-left: 3px solid transparent;
  cursor: text;
  transition: border-color 0.15s, background 0.15s;
}

.script-paragraph:hover {
  background: rgba(255, 255, 255, 0.02);
}

.script-paragraph.active {
  border-left-color: var(--primary);
  background: rgba(88, 166, 255, 0.04);
}

.script-paragraph textarea {
  width: 100%;
  background: none;
  border: none;
  color: var(--text);
  font-size: 0.9rem;
  line-height: 1.7;
  resize: none;
  outline: none;
  font-family: inherit;
}

.script-visual-tag {
  display: inline-block;
  padding: 2px 10px;
  margin: 6px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.script-divider {
  border: none;
  border-top: 1px dashed var(--border);
  margin: 4px 12px;
}

/* Right: preview panel */
.preview-panel {
  width: 400px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex-shrink: 0;
}

.preview-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.preview-placeholder {
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
}

.preview-image {
  max-width: 100%;
  max-height: 400px;
  border-radius: 6px;
  object-fit: contain;
}

.preview-meta {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
}

.preview-status {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.preview-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-action {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.8rem;
  padding: 4px 0;
  cursor: pointer;
  text-align: left;
  transition: color 0.15s;
}

.preview-action:hover {
  color: var(--text);
}

.audio-player {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
}

.audio-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.audio-text {
  font-size: 0.8rem;
  color: var(--text);
  margin-bottom: 8px;
  font-style: italic;
}

/* Editor bottom bar */
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 0.8rem;
}

.editor-footer-status {
  color: var(--text-muted);
}

.editor-footer-actions {
  display: flex;
  gap: 8px;
}
```

**Step 2: Create FormatSidebar component**

```tsx
// web/src/components/FormatSidebar.tsx
interface Format {
  id: string;
  label: string;
  status: string;
}

interface Props {
  formats: Format[];
  selectedFormat: string;
  onSelectFormat: (id: string) => void;
  voice: string;
  onVoiceChange: (v: string) => void;
  aspectRatio: string;
  onAspectRatioChange: (r: string) => void;
  preset: string;
  onPresetChange: (p: string) => void;
}

const VOICES = [
  { value: 'BV700_V2_streaming', label: '灿灿 2.0' },
  { value: 'BV405_streaming', label: '微晴' },
  { value: 'BV407_streaming', label: '然月' },
];

const RATIOS = [
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '3:4', label: '3:4 小红书' },
  { value: '1:1', label: '1:1 方形' },
];

const PRESETS = [
  { value: 'knowledge-explainer', label: '知识讲解' },
  { value: 'tutorial', label: '教程' },
];

function statusText(s: string): string {
  const map: Record<string, string> = {
    ready: '· 就绪',
    generating: '· 生成中',
    pending: '· 未开始',
    failed: '· 失败',
  };
  return map[s] || '';
}

export default function FormatSidebar(props: Props) {
  return (
    <div className="format-sidebar">
      <div className="section-label">输出格式</div>
      {props.formats.map((f) => (
        <div
          key={f.id}
          className={`format-item${props.selectedFormat === f.id ? ' selected' : ''}`}
          onClick={() => props.onSelectFormat(f.id)}
        >
          <div className="format-item-label">{f.label}</div>
          <div className="format-item-status">{statusText(f.status)}</div>
        </div>
      ))}

      <div className="format-settings">
        <div className="section-label">视频设置</div>
        <div className="format-setting">
          <div className="format-setting-label">配音</div>
          <select value={props.voice} onChange={(e) => props.onVoiceChange(e.target.value)}>
            {VOICES.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </select>
        </div>
        <div className="format-setting">
          <div className="format-setting-label">比例</div>
          <select value={props.aspectRatio} onChange={(e) => props.onAspectRatioChange(e.target.value)}>
            {RATIOS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="format-setting">
          <div className="format-setting-label">风格</div>
          <select value={props.preset} onChange={(e) => props.onPresetChange(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Create ScriptEditor component**

```tsx
// web/src/components/ScriptEditor.tsx
import { useRef, useEffect } from 'react';

interface Paragraph {
  id: string;
  text: string;
  visualTag?: string;
}

interface Props {
  paragraphs: Paragraph[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onChange: (id: string, text: string) => void;
}

export default function ScriptEditor({ paragraphs, activeId, onActivate, onChange }: Props) {
  return (
    <div className="script-panel">
      <div className="script-panel-header">脚本</div>
      <div className="script-content">
        {paragraphs.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <hr className="script-divider" />}
            {p.visualTag && <span className="script-visual-tag">{p.visualTag}</span>}
            <div
              className={`script-paragraph${activeId === p.id ? ' active' : ''}`}
              onClick={() => onActivate(p.id)}
            >
              <AutoResizeTextarea
                value={p.text}
                onChange={(val) => onChange(p.id, val)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutoResizeTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="script-paragraph"
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
```

**Step 4: Create PreviewPanel component**

```tsx
// web/src/components/PreviewPanel.tsx
interface Visual {
  id: string;
  type: string;
  template?: string;
  prompt?: string;
  status: string;
  asset: string | null;
}

interface Props {
  visual: Visual | null;
  ttsText: string | null;
  onRegenerate: () => void;
}

export default function PreviewPanel({ visual, ttsText, onRegenerate }: Props) {
  return (
    <div className="preview-panel">
      <div className="preview-area">
        {!visual ? (
          <div className="preview-placeholder">选择一个段落查看画面</div>
        ) : visual.asset ? (
          visual.type === 'broll' ? (
            <video src={visual.asset} controls style={{ maxWidth: '100%', maxHeight: '400px', borderRadius: '6px' }} />
          ) : (
            <img src={visual.asset} alt="" className="preview-image" />
          )
        ) : (
          <div className="preview-placeholder">
            {visual.status === 'generating' ? '生成中...' : '暂无画面'}
          </div>
        )}
      </div>

      {visual && (
        <div className="preview-meta">
          <div className="preview-status">
            {visual.type === 'card' ? '知识卡片' : 'B-roll'}
            {visual.template && ` · ${visual.template}`}
            {' · '}
            {visual.status}
          </div>
          <div className="preview-actions">
            <button className="preview-action" onClick={onRegenerate}>重新生成</button>
            <button className="preview-action">编辑提示词</button>
            <button className="preview-action">上传替换</button>
          </div>
        </div>
      )}

      {ttsText && (
        <div className="audio-player">
          <div className="audio-label">配音</div>
          <div className="audio-text">"{ttsText}"</div>
        </div>
      )}
    </div>
  );
}
```

**Step 5: Implement Editor page**

```tsx
// web/src/pages/Editor.tsx
import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchContent, getTimeline, generateTimeline, confirmAllSegments, updateSegment } from '../api';
import FormatSidebar from '../components/FormatSidebar';
import ScriptEditor from '../components/ScriptEditor';
import PreviewPanel from '../components/PreviewPanel';

interface ContentItem {
  id: string;
  title: string;
  body?: string;
  status: string;
}

interface TtsSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  status: string;
}

interface VisualSegment {
  id: string;
  type: string;
  template?: string;
  prompt?: string;
  status: string;
  asset: string | null;
  linkedTts: string[];
}

interface Timeline {
  version: string;
  contentId: string;
  preset: string;
  aspectRatio: string;
  tracks: {
    tts: TtsSegment[];
    visual: VisualSegment[];
    subtitle: { asset: string | null; status: string };
  };
}

const DEFAULT_FORMATS = [
  { id: 'video', label: '短视频', status: 'pending' },
  { id: 'xiaohongshu', label: '小红书', status: 'pending' },
  { id: 'wechat', label: '公众号', status: 'pending' },
];

export default function Editor() {
  const { contentId } = useParams<{ contentId: string }>();
  const queryClient = useQueryClient();

  const [selectedFormat, setSelectedFormat] = useState('video');
  const [activeParaId, setActiveParaId] = useState<string | null>(null);
  const [voice, setVoice] = useState('BV700_V2_streaming');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [preset, setPreset] = useState('knowledge-explainer');

  const { data: content } = useQuery<ContentItem>({
    queryKey: ['content', contentId],
    queryFn: () => fetchContent(contentId!) as Promise<ContentItem>,
    enabled: !!contentId,
  });

  const { data: timelineData } = useQuery({
    queryKey: ['timeline', contentId],
    queryFn: () => getTimeline(contentId!),
    enabled: !!contentId,
    retry: false,
  });

  const timeline: Timeline | null = timelineData?.timeline ?? null;

  const generateMut = useMutation({
    mutationFn: () => generateTimeline(contentId!, preset, aspectRatio),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  const confirmMut = useMutation({
    mutationFn: () => confirmAllSegments(contentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  const paragraphs = useMemo(() => {
    if (!timeline) return [];
    return timeline.tracks.tts.map((seg) => {
      const visual = timeline.tracks.visual.find((v) => v.linkedTts.includes(seg.id));
      let visualTag: string | undefined;
      if (visual) {
        visualTag = visual.type === 'card'
          ? (visual.template || '卡片')
          : `B-roll${visual.prompt ? ': ' + visual.prompt : ''}`;
      }
      return { id: seg.id, text: seg.text, visualTag };
    });
  }, [timeline]);

  const activeVisual = useMemo(() => {
    if (!timeline || !activeParaId) return null;
    return timeline.tracks.visual.find((v) => v.linkedTts.includes(activeParaId)) ?? null;
  }, [timeline, activeParaId]);

  const activeTtsText = useMemo(() => {
    if (!timeline || !activeParaId) return null;
    return timeline.tracks.tts.find((s) => s.id === activeParaId)?.text ?? null;
  }, [timeline, activeParaId]);

  const readyCount = timeline
    ? timeline.tracks.tts.filter((s) => s.status === 'confirmed' || s.status === 'ready').length
    : 0;
  const totalCount = timeline?.tracks.tts.length ?? 0;

  const formats = DEFAULT_FORMATS.map((f) => ({
    ...f,
    status: f.id === 'video' && timeline ? 'ready' : f.status,
  }));

  function handleParaChange(id: string, text: string) {
    // Local edit — future: sync back to backend
    // For now just update local state via paragraphs
  }

  function handleRegenerate() {
    if (activeVisual && contentId) {
      updateSegment(contentId, activeVisual.id, { status: 'pending' }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['timeline', contentId] });
      });
    }
  }

  if (!contentId) {
    return <div className="page">缺少内容 ID</div>;
  }

  return (
    <div className="editor">
      <div className="editor-header">
        <div className="editor-header-left">
          <Link to="/content" className="editor-back">{'< 返回'}</Link>
          <span className="editor-title">{content?.title || '加载中...'}</span>
        </div>
        <div className="editor-footer-actions">
          <button className="btn btn-sm">预览</button>
          <button className="btn btn-sm btn-primary">发布</button>
        </div>
      </div>

      <div className="editor-body">
        <FormatSidebar
          formats={formats}
          selectedFormat={selectedFormat}
          onSelectFormat={setSelectedFormat}
          voice={voice}
          onVoiceChange={setVoice}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          preset={preset}
          onPresetChange={setPreset}
        />

        {!timeline ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <p className="muted" style={{ marginBottom: '16px' }}>尚未生成时间轴</p>
              <button
                className="btn btn-primary"
                onClick={() => generateMut.mutate()}
                disabled={generateMut.isPending}
              >
                {generateMut.isPending ? '生成中...' : '生成内容'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <ScriptEditor
              paragraphs={paragraphs}
              activeId={activeParaId}
              onActivate={setActiveParaId}
              onChange={handleParaChange}
            />
            <PreviewPanel
              visual={activeVisual}
              ttsText={activeTtsText}
              onRegenerate={handleRegenerate}
            />
          </>
        )}
      </div>

      {timeline && (
        <div className="editor-footer">
          <span className="editor-footer-status">{readyCount}/{totalCount} 段就绪</span>
          <div className="editor-footer-actions">
            <button
              className="btn btn-sm"
              onClick={() => confirmMut.mutate()}
              disabled={confirmMut.isPending}
            >
              全部确认
            </button>
            <button className="btn btn-sm">导出剪映</button>
            <button className="btn btn-sm btn-primary">生成视频</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 6: Verify**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run build`

**Step 7: Commit**

```bash
git add web/
git commit -m "feat(web): add full-screen split-pane Editor with script editing and preview"
```

---

### Task 5: Publish Page

**Files:**
- Rewrite: `web/src/pages/Publish.tsx`
- Modify: `web/src/index.css` (publish styles)

**Step 1: Add publish CSS**

Add to `web/src/index.css`:
```css
/* Publish */
.publish-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.publish-tab {
  padding: 8px 16px;
  font-size: 0.875rem;
  color: var(--text-muted);
  border: none;
  background: none;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s;
}

.publish-tab:hover {
  color: var(--text);
}

.publish-tab.active {
  color: var(--text);
  border-bottom-color: var(--primary);
}

.publish-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 12px;
}

.publish-item-title {
  font-weight: 500;
  margin-bottom: 16px;
}

.publish-platform {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  font-size: 0.875rem;
}

.publish-platform + .publish-platform {
  border-top: 1px solid var(--border);
}

.publish-platform-name {
  color: var(--text);
}

.publish-platform-status {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.publish-platform-metrics {
  color: var(--text-muted);
  font-size: 0.8rem;
}
```

**Step 2: Implement Publish page**

```tsx
// web/src/pages/Publish.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchContents } from '../api';

interface ContentItem {
  id: string;
  title: string;
  status: string;
  platform?: string;
}

const TABS = ['待发布', '已发布', '失败'];

export default function Publish() {
  const [activeTab, setActiveTab] = useState('待发布');

  const { data: contents = [] } = useQuery<ContentItem[]>({
    queryKey: ['contents'],
    queryFn: fetchContents as () => Promise<ContentItem[]>,
  });

  // Placeholder publish data — will be enriched with real publish status API
  const publishItems = (contents as ContentItem[])
    .filter((c) => c.status === 'ready' || c.status === 'published')
    .map((c) => ({
      id: c.id,
      title: c.title,
      formats: [
        {
          type: '短视频',
          platforms: [
            { name: '抖音', status: c.status === 'published' ? '已发布' : '待发布' },
            { name: '快手', status: '待发布' },
            { name: '视频号', status: '待发布' },
          ],
        },
      ],
    }));

  return (
    <div className="page">
      <h1>发布</h1>

      <div className="publish-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`publish-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {publishItems.length === 0 ? (
        <p className="muted">暂无可发布内容</p>
      ) : (
        publishItems.map((item) => (
          <div key={item.id} className="publish-item">
            <div className="publish-item-title">{item.title}</div>
            {item.formats.map((fmt) => (
              <div key={fmt.type}>
                <div className="section-label" style={{ marginTop: '8px' }}>{fmt.type}</div>
                {fmt.platforms.map((p) => (
                  <div key={p.name} className="publish-platform">
                    <span className="publish-platform-name">{p.name}</span>
                    <span className="publish-platform-status">{p.status}</span>
                    {p.status === '待发布' && (
                      <button className="btn btn-sm">发布</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
```

**Step 3: Verify and commit**

```bash
cd /Users/jiaxintang/AutoCrew/web && npm run build
git add web/
git commit -m "feat(web): add Publish page with platform status"
```

---

### Task 6: Settings Page and Command Palette

**Files:**
- Rewrite: `web/src/pages/Settings.tsx`
- Rewrite: `web/src/components/CommandPalette.tsx`

**Step 1: Implement Settings page**

```tsx
// web/src/pages/Settings.tsx
export default function Settings() {
  return (
    <div className="page" style={{ maxWidth: '600px' }}>
      <h1>设置</h1>

      <div className="card" style={{ marginBottom: '16px' }}>
        <h3>平台账号</h3>
        <p className="muted" style={{ fontSize: '0.85rem' }}>绑定社媒平台账号以启用一键发布</p>
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {['抖音', '小红书', 'B站', '微信公众号'].map((p) => (
            <div key={p} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.875rem' }}>{p}</span>
              <button className="btn btn-sm">绑定</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <h3>AI 配置</h3>
        <div className="format-setting" style={{ marginTop: '12px' }}>
          <div className="format-setting-label">豆包 App ID</div>
          <input type="text" placeholder="输入 App ID" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
        <div className="format-setting" style={{ marginTop: '8px' }}>
          <div className="format-setting-label">豆包 Access Token</div>
          <input type="password" placeholder="输入 Access Token" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
      </div>

      <div className="card">
        <h3>导出</h3>
        <div className="format-setting" style={{ marginTop: '12px' }}>
          <div className="format-setting-label">剪映草稿目录</div>
          <input type="text" placeholder="~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Implement CommandPalette**

```tsx
// web/src/components/CommandPalette.tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = [
    { label: '发现选题', action: () => navigate('/') },
    { label: '我的内容', action: () => navigate('/content') },
    { label: '发布中心', action: () => navigate('/publish') },
    { label: '设置', action: () => navigate('/settings') },
  ];

  const filtered = commands.filter((c) => c.label.includes(query));

  function run(cmd: typeof commands[0]) {
    cmd.action();
    setOpen(false);
    setQuery('');
  }

  return (
    <>
      <button className="topbar-link" onClick={() => setOpen(true)}>
        Cmd+K
      </button>
      {open && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '20vh', zIndex: 100,
        }} onClick={() => setOpen(false)}>
          <div style={{
            width: '400px', background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: '10px', overflow: 'hidden',
          }} onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="搜索命令..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%', padding: '12px 16px', background: 'none', border: 'none',
                borderBottom: '1px solid var(--border)', color: 'var(--text)', fontSize: '0.9rem', outline: 'none',
              }}
            />
            <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
              {filtered.map((cmd) => (
                <div
                  key={cmd.label}
                  onClick={() => run(cmd)}
                  style={{
                    padding: '10px 16px', cursor: 'pointer', fontSize: '0.875rem',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  {cmd.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

**Step 3: Verify and commit**

```bash
cd /Users/jiaxintang/AutoCrew/web && npm run build
git add web/
git commit -m "feat(web): add Settings page and Cmd+K command palette"
```

---

### Task 7: Cleanup Old Pages and Final Verification

**Files:**
- Delete: `web/src/pages/Dashboard.tsx`
- Delete: `web/src/pages/Workflows.tsx`
- Delete: `web/src/pages/Research.tsx`
- Delete: `web/src/pages/Contents.tsx`
- Delete: `web/src/pages/AssetPanel.tsx`
- Keep: `web/src/components/SegmentCard.tsx` (may reuse later)
- Keep: `web/src/components/VisualPreview.tsx` (may reuse later)

**Step 1: Remove old page files**

```bash
rm web/src/pages/Dashboard.tsx web/src/pages/Workflows.tsx web/src/pages/Research.tsx web/src/pages/Contents.tsx web/src/pages/AssetPanel.tsx
```

**Step 2: Remove old CSS classes**

Remove from `web/src/index.css`:
- `.layout` (replaced by `.app`)
- `.sidebar`, `.sidebar-brand` (replaced by `.topbar`)
- `.nav-link` (replaced by `.topbar-link`)
- `.main-content` (replaced by `.app-main`)

Keep all utility classes: `.card`, `.badge`, `.btn`, `.table-container`, etc.

**Step 3: Remove unused imports from api.ts**

Remove these functions from `web/src/api.ts` that are no longer called:
- `fetchWorkflows`
- `fetchWorkflowTemplates`
- `createWorkflow`
- `startWorkflow`
- `approveWorkflow`
- `cancelWorkflow`
- `fetchWorkflowStatus`

Keep all other functions.

**Step 4: Verify build and all pages work**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run build`
Expected: Build succeeds, no dead imports

**Step 5: Commit**

```bash
git add -A web/
git commit -m "refactor(web): remove old pages (Dashboard, Workflows, Research, Contents, AssetPanel)"
```

**Step 6: Run the dev server and verify visually**

Run: `cd /Users/jiaxintang/AutoCrew/web && npm run dev`
Open http://localhost:5173 and verify:
- Top bar navigation works (Discover, Content, Publish, Settings)
- Cmd+K opens command palette
- Discover shows topic cards (or empty state)
- Content shows kanban with 4 columns
- Clicking a content card opens the 3-column editor
- Publish shows platform list
- Settings shows config form
