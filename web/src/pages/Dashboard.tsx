import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchStatus, fetchTopics, fetchContents, useEventStream } from '../api';

interface StatusData {
  topics?: number;
  contents?: number;
  drafting?: number;
  reviewing?: number;
  published?: number;
}

interface EventItem {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<EventItem[]>([]);

  const { data: status } = useQuery<StatusData>({
    queryKey: ['status'],
    queryFn: fetchStatus as () => Promise<StatusData>,
    refetchInterval: 10000,
  });

  const { data: topics } = useQuery({
    queryKey: ['topics'],
    queryFn: fetchTopics,
  });

  const { data: contents } = useQuery({
    queryKey: ['contents'],
    queryFn: fetchContents,
  });

  useEventStream(
    useCallback((event: Record<string, unknown>) => {
      setEvents((prev) => [
        {
          id: crypto.randomUUID(),
          type: (event.type as string) || 'info',
          message: (event.message as string) || JSON.stringify(event),
          timestamp: new Date().toLocaleTimeString('zh-CN'),
        },
        ...prev.slice(0, 49),
      ]);
    }, [])
  );

  const topicCount = (topics as unknown[] | undefined)?.length ?? status?.topics ?? 0;
  const contentCount = (contents as unknown[] | undefined)?.length ?? status?.contents ?? 0;

  return (
    <div>
      <h1>仪表盘</h1>

      <div className="card-grid">
        <div className="card">
          <div className="card-label">选题总数</div>
          <div className="card-value">{topicCount}</div>
        </div>
        <div className="card">
          <div className="card-label">内容总数</div>
          <div className="card-value">{contentCount}</div>
        </div>
        <div className="card">
          <div className="card-label">撰写中</div>
          <div className="card-value">{status?.drafting ?? 0}</div>
        </div>
        <div className="card">
          <div className="card-label">审核中</div>
          <div className="card-value">{status?.reviewing ?? 0}</div>
        </div>
        <div className="card">
          <div className="card-label">已发布</div>
          <div className="card-value">{status?.published ?? 0}</div>
        </div>
      </div>

      <div className="actions" style={{ marginTop: '1.5rem' }}>
        <button className="btn btn-primary" onClick={() => navigate('/workflows')}>
          新建工作流
        </button>
        <button className="btn" onClick={() => navigate('/research')}>
          开始研究
        </button>
      </div>

      <h2 style={{ marginTop: '2rem' }}>最近活动</h2>
      <div className="activity-feed">
        {events.length === 0 && <p className="muted">暂无活动</p>}
        {events.map((ev) => (
          <div key={ev.id} className="activity-item">
            <span className={`badge badge-${ev.type}`}>{ev.type}</span>
            <span>{ev.message}</span>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {ev.timestamp}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
