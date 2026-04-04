interface TtsSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  status: string;
}

interface VisualSegment {
  id: string;
  type: string;
  template?: string;
  prompt?: string;
  status: string;
  asset: string | null;
}

interface SegmentCardProps {
  tts: TtsSegment;
  visual?: VisualSegment;
  isActive: boolean;
  onClick: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#94a3b8',
  generating: '#f59e0b',
  ready: '#22c55e',
  confirmed: '#3b82f6',
  failed: '#ef4444',
};

export default function SegmentCard({ tts, visual, isActive, onClick }: SegmentCardProps) {
  const containerStyle: React.CSSProperties = {
    padding: '12px 16px',
    cursor: 'pointer',
    borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
    backgroundColor: isActive ? '#eff6ff' : 'transparent',
    borderBottom: '1px solid #e5e7eb',
    transition: 'background-color 0.15s',
  };

  const textStyle: React.CSSProperties = {
    fontSize: '14px',
    lineHeight: 1.6,
    color: '#1f2937',
    margin: 0,
  };

  const durationStyle: React.CSSProperties = {
    fontSize: '12px',
    color: '#9ca3af',
    marginTop: '4px',
  };

  const visualRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '6px',
    fontSize: '12px',
    color: '#6b7280',
  };

  const statusDotStyle = (status: string): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.pending,
    flexShrink: 0,
  });

  const icon = visual?.type === 'broll' ? '\uD83C\uDFAC' : '\uD83D\uDCCA';
  const label = visual?.template || visual?.prompt || visual?.type || '';

  return (
    <div style={containerStyle} onClick={onClick}>
      <p style={textStyle}>{tts.text}</p>
      <div style={durationStyle}>{tts.estimatedDuration.toFixed(1)}s</div>
      {visual && (
        <div style={visualRowStyle}>
          <span>{icon}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </span>
          <span style={statusDotStyle(visual.status)} title={visual.status} />
        </div>
      )}
    </div>
  );
}
