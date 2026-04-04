import { updateSegment } from '../api';

interface Visual {
  id: string;
  type: string;
  template?: string;
  prompt?: string;
  data?: Record<string, unknown>;
  status: string;
  asset: string | null;
  opacity?: number;
}

interface VisualPreviewProps {
  contentId: string;
  visual: Visual | null;
  onRefresh: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待生成',
  generating: '生成中...',
  ready: '已就绪',
  confirmed: '已确认',
  failed: '生成失败',
};

export default function VisualPreview({ contentId, visual, onRefresh }: VisualPreviewProps) {
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '24px',
  };

  const placeholderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    color: '#9ca3af',
    fontSize: '15px',
  };

  const previewAreaStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: '8px',
    overflow: 'hidden',
    minHeight: '300px',
  };

  const iconPlaceholderStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    color: '#9ca3af',
  };

  const actionsStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    marginTop: '16px',
    flexWrap: 'wrap',
  };

  const btnStyle: React.CSSProperties = {
    padding: '8px 16px',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    backgroundColor: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#374151',
  };

  const metaStyle: React.CSSProperties = {
    marginTop: '12px',
    fontSize: '12px',
    color: '#6b7280',
  };

  if (!visual) {
    return (
      <div style={containerStyle}>
        <div style={placeholderStyle}>选择左侧文案段落查看素材预览</div>
      </div>
    );
  }

  async function handleRegenerate() {
    if (!visual) return;
    await updateSegment(contentId, visual.id, { status: 'pending' });
    onRefresh();
  }

  const icon = visual.type === 'broll' ? '\uD83C\uDFAC' : '\uD83D\uDCCA';
  const statusText = STATUS_LABELS[visual.status] || visual.status;

  return (
    <div style={containerStyle}>
      <div style={previewAreaStyle}>
        {visual.asset ? (
          visual.type === 'broll' ? (
            <video
              src={visual.asset}
              controls
              style={{ maxWidth: '100%', maxHeight: '100%' }}
            />
          ) : (
            <img
              src={visual.asset}
              alt="visual preview"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          )
        ) : (
          <div style={iconPlaceholderStyle}>
            <span style={{ fontSize: '48px' }}>{icon}</span>
            <span style={{ fontSize: '14px' }}>{statusText}</span>
          </div>
        )}
      </div>

      <div style={metaStyle}>
        <div>
          <strong>类型:</strong> {visual.type}
          {visual.template && <> | <strong>模板:</strong> {visual.template}</>}
        </div>
        {visual.prompt && (
          <div style={{ marginTop: '4px' }}>
            <strong>提示词:</strong> {visual.prompt}
          </div>
        )}
        {visual.opacity != null && (
          <div style={{ marginTop: '4px' }}>
            <strong>透明度:</strong> {visual.opacity}
          </div>
        )}
      </div>

      <div style={actionsStyle}>
        <button style={btnStyle} onClick={handleRegenerate}>
          {'\uD83D\uDD04'} 重新生成
        </button>
        <button style={btnStyle} onClick={() => { /* TODO: edit modal */ }}>
          {'\uD83D\uDCDD'} 编辑
        </button>
        <button style={btnStyle} onClick={() => { /* TODO: upload replacement */ }}>
          {'\uD83D\uDCE4'} 上传替换
        </button>
      </div>
    </div>
  );
}
