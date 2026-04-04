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
      const res = data as { content?: { id: string }; id?: string };
      const id = res.content?.id ?? res.id;
      if (id) navigate(`/content/${id}`);
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
