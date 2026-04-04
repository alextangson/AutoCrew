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
