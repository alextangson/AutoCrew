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
