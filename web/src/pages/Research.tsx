import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchTopics, executeTool } from '../api';

interface Topic {
  id: string;
  title: string;
  score?: number;
  source?: string;
  createdAt?: string;
}

export default function Research() {
  const queryClient = useQueryClient();

  const { data: topics = [] } = useQuery<Topic[]>({
    queryKey: ['topics'],
    queryFn: fetchTopics as () => Promise<Topic[]>,
  });

  const researchMut = useMutation({
    mutationFn: () => executeTool('autocrew_research', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });

  return (
    <div>
      <div className="page-header">
        <h1>选题研究</h1>
        <button
          className="btn btn-primary"
          onClick={() => researchMut.mutate()}
          disabled={researchMut.isPending}
        >
          {researchMut.isPending ? '研究中...' : '新建研究'}
        </button>
      </div>

      {researchMut.isError && (
        <div className="card" style={{ borderColor: 'var(--red)', marginBottom: '1rem' }}>
          <p style={{ color: 'var(--red)' }}>研究失败: {(researchMut.error as Error).message}</p>
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>选题</th>
              <th>评分</th>
              <th>来源</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {(topics as Topic[]).length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                  暂无选题
                </td>
              </tr>
            )}
            {(topics as Topic[]).map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td>
                  {t.score != null && (
                    <span className="score-badge">{t.score.toFixed(1)}</span>
                  )}
                </td>
                <td>{t.source || '-'}</td>
                <td>{t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
