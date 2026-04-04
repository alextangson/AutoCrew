import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getTimeline, generateTimeline, confirmAllSegments } from '../api';
import SegmentCard from '../components/SegmentCard';
import VisualPreview from '../components/VisualPreview';

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
  data?: Record<string, unknown>;
  status: string;
  asset: string | null;
  opacity?: number;
}

interface Segment {
  tts: TtsSegment;
  visual?: VisualSegment;
}

interface Timeline {
  preset?: string;
  aspectRatio?: string;
  segments?: Segment[];
}

const PRESETS = [
  { value: 'talking-head', label: 'Talking Head' },
  { value: 'cinematic', label: 'Cinematic B-Roll' },
  { value: 'card-overlay', label: 'Card Overlay' },
  { value: 'mixed', label: 'Mixed' },
];

const ASPECT_RATIOS = [
  { value: '9:16', label: '9:16 (竖屏)' },
  { value: '16:9', label: '16:9 (横屏)' },
  { value: '1:1', label: '1:1 (方形)' },
];

export default function AssetPanel() {
  const { contentId } = useParams<{ contentId: string }>();
  const queryClient = useQueryClient();

  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(0);
  const [preset, setPreset] = useState('mixed');
  const [aspectRatio, setAspectRatio] = useState('9:16');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['timeline', contentId],
    queryFn: () => getTimeline(contentId!),
    enabled: !!contentId,
    retry: false,
  });

  const timeline: Timeline | null = data?.timeline ?? null;
  const hasTimeline = timeline && Array.isArray(timeline.segments) && timeline.segments.length > 0;

  const generateMut = useMutation({
    mutationFn: () => generateTimeline(contentId!, preset, aspectRatio),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  const confirmMut = useMutation({
    mutationFn: () => confirmAllSegments(contentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: ['timeline', contentId] });
  }

  if (!contentId) {
    return <div style={{ padding: '24px' }}>缺少内容 ID</div>;
  }

  // Styles
  const pageStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  };

  const topBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '13px',
    color: '#6b7280',
    flexShrink: 0,
  };

  const splitStyle: React.CSSProperties = {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  };

  const leftPanelStyle: React.CSSProperties = {
    width: '45%',
    overflowY: 'auto',
    borderRight: '1px solid #e5e7eb',
  };

  const rightPanelStyle: React.CSSProperties = {
    width: '55%',
    overflowY: 'auto',
  };

  const bottomBarStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '12px 20px',
    borderTop: '1px solid #e5e7eb',
    flexShrink: 0,
  };

  const confirmBtnStyle: React.CSSProperties = {
    padding: '8px 20px',
    backgroundColor: '#22c55e',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  };

  // No timeline state — show generate form
  if (!hasTimeline && !isLoading) {
    const formStyle: React.CSSProperties = {
      maxWidth: '400px',
      margin: '80px auto',
      padding: '32px',
      border: '1px solid #e5e7eb',
      borderRadius: '12px',
      backgroundColor: '#fff',
    };

    const fieldStyle: React.CSSProperties = {
      marginBottom: '16px',
    };

    const labelStyle: React.CSSProperties = {
      display: 'block',
      fontSize: '13px',
      fontWeight: 500,
      color: '#374151',
      marginBottom: '6px',
    };

    const selectStyle: React.CSSProperties = {
      width: '100%',
      padding: '8px 12px',
      border: '1px solid #d1d5db',
      borderRadius: '6px',
      fontSize: '14px',
    };

    const generateBtnStyle: React.CSSProperties = {
      width: '100%',
      padding: '10px',
      backgroundColor: '#3b82f6',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: 500,
      marginTop: '8px',
    };

    return (
      <div style={{ padding: '24px' }}>
        <h1>素材面板</h1>
        {isError && (
          <div style={{ color: '#ef4444', marginBottom: '16px', fontSize: '14px' }}>
            {(error as Error)?.message || '加载失败'}
          </div>
        )}
        <div style={formStyle}>
          <h3 style={{ margin: '0 0 20px', fontSize: '16px' }}>生成视频时间线</h3>
          <div style={fieldStyle}>
            <label style={labelStyle}>预设风格</label>
            <select style={selectStyle} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>画面比例</label>
            <select style={selectStyle} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {ASPECT_RATIOS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <button
            style={generateBtnStyle}
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
          >
            {generateMut.isPending ? '生成中...' : '生成时间线'}
          </button>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div style={{ padding: '24px' }}>
        <h1>素材面板</h1>
        <div style={{ color: '#9ca3af', marginTop: '40px', textAlign: 'center' }}>加载中...</div>
      </div>
    );
  }

  // Timeline loaded — split view
  const segments: Segment[] = timeline?.segments ?? [];
  const activeSegment = segments[activeSegmentIndex] ?? null;

  const totalDuration = segments.reduce((sum, s) => sum + (s.tts?.estimatedDuration ?? 0), 0);

  return (
    <div style={pageStyle}>
      <div style={topBarStyle}>
        <div>
          <strong>预设:</strong> {timeline?.preset || '-'}
          {' | '}
          <strong>比例:</strong> {timeline?.aspectRatio || '-'}
          {' | '}
          <strong>段落:</strong> {segments.length}
          {' | '}
          <strong>总时长:</strong> {totalDuration.toFixed(1)}s
        </div>
      </div>

      <div style={splitStyle}>
        <div style={leftPanelStyle}>
          {segments.map((seg, i) => (
            <SegmentCard
              key={seg.tts.id}
              tts={seg.tts}
              visual={seg.visual}
              isActive={i === activeSegmentIndex}
              onClick={() => setActiveSegmentIndex(i)}
            />
          ))}
        </div>
        <div style={rightPanelStyle}>
          <VisualPreview
            contentId={contentId}
            visual={activeSegment?.visual ?? null}
            onRefresh={handleRefresh}
          />
        </div>
      </div>

      <div style={bottomBarStyle}>
        <button
          style={confirmBtnStyle}
          onClick={() => confirmMut.mutate()}
          disabled={confirmMut.isPending}
        >
          {confirmMut.isPending ? '确认中...' : '\u2705 全部确认'}
        </button>
      </div>
    </div>
  );
}
