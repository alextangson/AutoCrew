import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchWorkflows,
  fetchWorkflowTemplates,
  fetchWorkflowStatus,
  createWorkflow,
  startWorkflow,
  approveWorkflow,
  cancelWorkflow,
} from '../api';

interface Workflow {
  id: string;
  name: string;
  status: string;
  steps?: Step[];
  createdAt?: string;
}

interface Step {
  name: string;
  status: string;
}

interface Template {
  id: string;
  name: string;
  description?: string;
}

export default function Workflows() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  const { data: workflows = [] } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows as () => Promise<Workflow[]>,
    refetchInterval: 5000,
  });

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ['workflow-templates'],
    queryFn: fetchWorkflowTemplates as () => Promise<Template[]>,
    enabled: showTemplates,
  });

  const { data: detail } = useQuery<Workflow>({
    queryKey: ['workflow', selectedId],
    queryFn: () => fetchWorkflowStatus(selectedId!) as Promise<Workflow>,
    enabled: !!selectedId,
    refetchInterval: 3000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });

  const createMut = useMutation({
    mutationFn: (tplId: string) => createWorkflow(tplId),
    onSuccess: () => {
      invalidate();
      setShowTemplates(false);
    },
  });

  const startMut = useMutation({
    mutationFn: startWorkflow,
    onSuccess: invalidate,
  });

  const approveMut = useMutation({
    mutationFn: approveWorkflow,
    onSuccess: invalidate,
  });

  const cancelMut = useMutation({
    mutationFn: cancelWorkflow,
    onSuccess: invalidate,
  });

  function statusColor(s: string): string {
    const map: Record<string, string> = {
      running: 'blue',
      paused: 'orange',
      completed: 'green',
      failed: 'red',
      pending: 'default',
    };
    return map[s] || 'default';
  }

  return (
    <div>
      <div className="page-header">
        <h1>工作流</h1>
        <button className="btn btn-primary" onClick={() => setShowTemplates(true)}>
          新建
        </button>
      </div>

      {showTemplates && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>选择模板</h3>
          {templates.length === 0 && <p className="muted">暂无模板</p>}
          {templates.map((t) => (
            <button
              key={t.id}
              className="btn"
              style={{ marginRight: '0.5rem', marginBottom: '0.5rem' }}
              onClick={() => createMut.mutate(t.id)}
              disabled={createMut.isPending}
            >
              {t.name}
            </button>
          ))}
          <button className="btn" onClick={() => setShowTemplates(false)}>
            取消
          </button>
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(workflows as Workflow[]).length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                  暂无工作流
                </td>
              </tr>
            )}
            {(workflows as Workflow[]).map((wf) => (
              <tr key={wf.id} onClick={() => setSelectedId(wf.id)} style={{ cursor: 'pointer' }}>
                <td>{wf.name || wf.id}</td>
                <td>
                  <span className={`badge badge-${statusColor(wf.status)}`}>{wf.status}</span>
                </td>
                <td>{wf.createdAt ? new Date(wf.createdAt).toLocaleString('zh-CN') : '-'}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  {wf.status === 'pending' && (
                    <button className="btn btn-sm" onClick={() => startMut.mutate(wf.id)}>
                      启动
                    </button>
                  )}
                  {wf.status === 'paused' && (
                    <button className="btn btn-sm btn-primary" onClick={() => approveMut.mutate(wf.id)}>
                      审批
                    </button>
                  )}
                  {(wf.status === 'running' || wf.status === 'paused') && (
                    <button className="btn btn-sm btn-danger" onClick={() => cancelMut.mutate(wf.id)}>
                      取消
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <h3>工作流详情: {detail.name || detail.id}</h3>
          <p>
            状态: <span className={`badge badge-${statusColor(detail.status)}`}>{detail.status}</span>
          </p>
          {detail.steps && (
            <div className="steps">
              {detail.steps.map((step, i) => (
                <div key={i} className={`step step-${step.status}`}>
                  <span className="step-num">{i + 1}</span>
                  <span>{step.name}</span>
                  <span className={`badge badge-${statusColor(step.status)}`}>{step.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
