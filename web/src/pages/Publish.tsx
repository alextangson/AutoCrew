import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchContents } from '../api';

interface ContentItem {
  id: string;
  title: string;
  status: string;
  platform?: string;
}

interface PublishPlatform {
  name: string;
  status: string;
}

interface PublishFormat {
  type: string;
  platforms: PublishPlatform[];
}

interface PublishItem {
  id: string;
  title: string;
  tab: string;
  formats: PublishFormat[];
}

const TABS = ['待发布', '已发布', '失败'];

function buildPublishItems(contents: ContentItem[]): PublishItem[] {
  return contents
    .filter((c) => c.status === 'ready' || c.status === 'published' || c.status === 'failed')
    .map((c) => {
      const isPublished = c.status === 'published';
      const isFailed = c.status === 'failed';
      const tab = isFailed ? '失败' : isPublished ? '已发布' : '待发布';

      return {
        id: c.id,
        title: c.title,
        tab,
        formats: [
          {
            type: '短视频',
            platforms: [
              { name: '抖音', status: isPublished ? '已发布' : isFailed ? '失败' : '待发布' },
              { name: '快手', status: '待发布' },
              { name: '视频号', status: '待发布' },
            ],
          },
        ],
      };
    });
}

export default function Publish() {
  const [activeTab, setActiveTab] = useState('待发布');

  const { data: contents = [] } = useQuery<ContentItem[]>({
    queryKey: ['contents'],
    queryFn: fetchContents as () => Promise<ContentItem[]>,
  });

  const allItems = buildPublishItems(contents as ContentItem[]);
  const filtered = allItems.filter((item) => item.tab === activeTab);

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
            {tab} ({allItems.filter((i) => i.tab === tab).length})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="muted">暂无{activeTab}内容</p>
      ) : (
        filtered.map((item) => (
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
