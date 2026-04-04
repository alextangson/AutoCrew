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
