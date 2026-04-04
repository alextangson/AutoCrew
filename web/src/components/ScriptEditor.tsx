import { useRef, useEffect } from 'react';

interface Paragraph {
  id: string;
  text: string;
  visualTag?: string;
}

interface Props {
  paragraphs: Paragraph[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onChange: (id: string, text: string) => void;
}

function AutoResizeTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="script-textarea"
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function ScriptEditor({ paragraphs, activeId, onActivate, onChange }: Props) {
  return (
    <div className="script-panel">
      <div className="script-panel-header">脚本</div>
      <div className="script-content">
        {paragraphs.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <hr className="script-divider" />}
            {p.visualTag && <span className="script-visual-tag">{p.visualTag}</span>}
            <div
              className={`script-paragraph${activeId === p.id ? ' active' : ''}`}
              onClick={() => onActivate(p.id)}
            >
              <AutoResizeTextarea
                value={p.text}
                onChange={(val) => onChange(p.id, val)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
