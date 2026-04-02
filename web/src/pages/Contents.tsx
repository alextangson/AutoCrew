import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchContents, fetchContent } from '../api';

interface ContentItem {
  id: string;
  title: string;
  platform?: string;
  status: string;
  createdAt?: string;
  body?: string;
}

export default function Contents() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: contents = [] } = useQuery<ContentItem[]>({
    queryKey: ['contents'],
    queryFn: fetchContents as () => Promise<ContentItem[]>,
  });

  const { data: detail } = useQuery<ContentItem>({
    queryKey: ['content', selectedId],
    queryFn: () => fetchContent(selectedId!) as Promise<ContentItem>,
    enabled: !!selectedId,
  });

  function statusColor(s: string): string {
    const map: Record<string, string> = {
      drafting: 'blue',
      reviewing: 'yellow',
      published: 'green',
      failed: 'red',
    };
    return map[s] || 'default';
  }

  return (
    <div>
      <h1>内容管理</h1>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>平台</th>
              <th>状态</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {(contents as ContentItem[]).length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                  暂无内容
                </td>
              </tr>
            )}
            {(contents as ContentItem[]).map((item) => (
              <tr key={item.id} onClick={() => setSelectedId(item.id)} style={{ cursor: 'pointer' }}>
                <td>{item.title}</td>
                <td>{item.platform || '-'}</td>
                <td>
                  <span className={`badge badge-${statusColor(item.status)}`}>{item.status}</span>
                </td>
                <td>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div className="page-header">
            <h3>{detail.title}</h3>
            <button className="btn btn-sm" onClick={() => setSelectedId(null)}>
              关闭
            </button>
          </div>
          <p>
            平台: {detail.platform || '-'} | 状态:{' '}
            <span className={`badge badge-${statusColor(detail.status)}`}>{detail.status}</span>
          </p>
          {detail.body && <div className="content-body">{detail.body}</div>}
        </div>
      )}
    </div>
  );
}
