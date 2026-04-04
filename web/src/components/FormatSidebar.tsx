interface Format {
  id: string;
  label: string;
  status: string;
}

interface Props {
  formats: Format[];
  selectedFormat: string;
  onSelectFormat: (id: string) => void;
  voice: string;
  onVoiceChange: (v: string) => void;
  aspectRatio: string;
  onAspectRatioChange: (r: string) => void;
  preset: string;
  onPresetChange: (p: string) => void;
}

const VOICES = [
  { value: 'BV700_V2_streaming', label: '灿灿 2.0' },
  { value: 'BV405_streaming', label: '微晴' },
  { value: 'BV407_streaming', label: '然月' },
];

const RATIOS = [
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '3:4', label: '3:4 小红书' },
  { value: '1:1', label: '1:1 方形' },
];

const PRESETS = [
  { value: 'knowledge-explainer', label: '知识讲解' },
  { value: 'tutorial', label: '教程' },
];

function statusText(s: string): string {
  const map: Record<string, string> = {
    ready: '· 就绪',
    generating: '· 生成中',
    pending: '· 未开始',
    failed: '· 失败',
  };
  return map[s] || '';
}

export default function FormatSidebar(props: Props) {
  return (
    <div className="format-sidebar">
      <div className="section-label">输出格式</div>
      {props.formats.map((f) => (
        <div
          key={f.id}
          className={`format-item${props.selectedFormat === f.id ? ' selected' : ''}`}
          onClick={() => props.onSelectFormat(f.id)}
        >
          <div className="format-item-label">{f.label}</div>
          <div className="format-item-status">{statusText(f.status)}</div>
        </div>
      ))}

      <div className="format-settings">
        <div className="section-label">视频设置</div>
        <div className="format-setting">
          <div className="format-setting-label">配音</div>
          <select value={props.voice} onChange={(e) => props.onVoiceChange(e.target.value)}>
            {VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
        </div>
        <div className="format-setting">
          <div className="format-setting-label">比例</div>
          <select value={props.aspectRatio} onChange={(e) => props.onAspectRatioChange(e.target.value)}>
            {RATIOS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="format-setting">
          <div className="format-setting-label">风格</div>
          <select value={props.preset} onChange={(e) => props.onPresetChange(e.target.value)}>
            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
