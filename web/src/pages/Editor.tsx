import { useState, useMemo, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchContent, getTimeline, generateTimeline, confirmAllSegments,
  updateSegment, updateSegmentText, exportJianying, renderVideo,
} from '../api';
import FormatSidebar from '../components/FormatSidebar';
import ScriptEditor from '../components/ScriptEditor';
import PreviewPanel from '../components/PreviewPanel';

interface ContentItem {
  id: string;
  title: string;
  body?: string;
  status: string;
}

interface TtsSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  status: string;
  asset: string | null;
}

interface VisualSegment {
  id: string;
  type: string;
  template?: string;
  prompt?: string;
  status: string;
  asset: string | null;
  linkedTts: string[];
}

interface Timeline {
  version: string;
  contentId: string;
  preset: string;
  aspectRatio: string;
  tracks: {
    tts: TtsSegment[];
    visual: VisualSegment[];
    subtitle: { asset: string | null; status: string };
  };
}

const DEFAULT_FORMATS = [
  { id: 'video', label: '短视频', status: 'pending' },
  { id: 'xiaohongshu', label: '小红书', status: 'pending' },
  { id: 'wechat', label: '公众号', status: 'pending' },
];

export default function Editor() {
  const { contentId } = useParams<{ contentId: string }>();
  const queryClient = useQueryClient();

  const [selectedFormat, setSelectedFormat] = useState('video');
  const [activeParaId, setActiveParaId] = useState<string | null>(null);
  const [voice, setVoice] = useState('BV700_V2_streaming');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [preset, setPreset] = useState('knowledge-explainer');
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const { data: content } = useQuery<ContentItem>({
    queryKey: ['content', contentId],
    queryFn: () => fetchContent(contentId!) as Promise<ContentItem>,
    enabled: !!contentId,
  });

  const { data: timelineData } = useQuery({
    queryKey: ['timeline', contentId],
    queryFn: () => getTimeline(contentId!),
    enabled: !!contentId,
    retry: false,
  });

  const timeline: Timeline | null = timelineData?.timeline ?? null;

  const generateMut = useMutation({
    mutationFn: () => generateTimeline(contentId!, preset, aspectRatio),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  const confirmMut = useMutation({
    mutationFn: () => confirmAllSegments(contentId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timeline', contentId] }),
  });

  const exportMut = useMutation({
    mutationFn: () => exportJianying(contentId!),
    onSuccess: (data) => {
      const res = data as { ok: boolean; path?: string; error?: string };
      if (res.ok) {
        setStatusMsg(`已导出到 ${res.path}`);
      } else {
        setStatusMsg(`导出失败: ${res.error}`);
      }
      setTimeout(() => setStatusMsg(null), 5000);
    },
    onError: (err) => {
      setStatusMsg(`导出失败: ${(err as Error).message}`);
      setTimeout(() => setStatusMsg(null), 5000);
    },
  });

  const renderMut = useMutation({
    mutationFn: () => renderVideo(contentId!),
    onSuccess: (data) => {
      const res = data as { ok: boolean; message?: string; error?: string };
      setStatusMsg(res.ok ? (res.message || '生成完成') : `失败: ${res.error}`);
      setTimeout(() => setStatusMsg(null), 5000);
    },
    onError: (err) => {
      setStatusMsg(`失败: ${(err as Error).message}`);
      setTimeout(() => setStatusMsg(null), 5000);
    },
  });

  const paragraphs = useMemo(() => {
    if (!timeline) return [];
    return timeline.tracks.tts.map((seg) => {
      const visual = timeline.tracks.visual.find((v) => v.linkedTts.includes(seg.id));
      let visualTag: string | undefined;
      if (visual) {
        visualTag = visual.type === 'card'
          ? (visual.template || '卡片')
          : `B-roll${visual.prompt ? ': ' + visual.prompt : ''}`;
      }
      return {
        id: seg.id,
        text: localEdits[seg.id] ?? seg.text,
        visualTag,
      };
    });
  }, [timeline, localEdits]);

  const activeVisual = useMemo(() => {
    if (!timeline || !activeParaId) return null;
    return timeline.tracks.visual.find((v) => v.linkedTts.includes(activeParaId)) ?? null;
  }, [timeline, activeParaId]);

  const activeTts = useMemo(() => {
    if (!timeline || !activeParaId) return null;
    return timeline.tracks.tts.find((s) => s.id === activeParaId) ?? null;
  }, [timeline, activeParaId]);

  const readyCount = timeline
    ? timeline.tracks.tts.filter((s) => s.status === 'confirmed' || s.status === 'ready').length
    : 0;
  const totalCount = timeline?.tracks.tts.length ?? 0;

  const formats = DEFAULT_FORMATS.map((f) => ({
    ...f,
    status: f.id === 'video' && timeline ? 'ready' : f.status,
  }));

  const handleParaChange = useCallback((id: string, text: string) => {
    setLocalEdits((prev) => ({ ...prev, [id]: text }));

    // Debounce save: 1 second after last keystroke
    if (saveTimers.current[id]) clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => {
      if (contentId) {
        updateSegmentText(contentId, id, text).catch(() => {
          // Silent fail for now
        });
      }
    }, 1000);
  }, [contentId]);

  function handleRegenerate() {
    if (activeVisual && contentId) {
      updateSegment(contentId, activeVisual.id, { status: 'pending' }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['timeline', contentId] });
      });
    }
  }

  if (!contentId) {
    return <div className="page">缺少内容 ID</div>;
  }

  return (
    <div className="editor">
      <div className="editor-header">
        <div className="editor-header-left">
          <Link to="/content" className="editor-back">{'< 返回'}</Link>
          <span className="editor-title">{content?.title || '加载中...'}</span>
        </div>
        <div className="editor-footer-actions">
          <button className="btn btn-sm">预览</button>
          <button className="btn btn-sm btn-primary">发布</button>
        </div>
      </div>

      {statusMsg && (
        <div style={{
          padding: '8px 20px',
          fontSize: '0.8rem',
          background: 'rgba(88, 166, 255, 0.08)',
          borderBottom: '1px solid var(--border)',
          color: 'var(--text)',
        }}>
          {statusMsg}
        </div>
      )}

      <div className="editor-body">
        <FormatSidebar
          formats={formats}
          selectedFormat={selectedFormat}
          onSelectFormat={setSelectedFormat}
          voice={voice}
          onVoiceChange={setVoice}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          preset={preset}
          onPresetChange={setPreset}
        />

        {!timeline ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <p className="muted" style={{ marginBottom: '16px' }}>尚未生成时间轴</p>
              <button
                className="btn btn-primary"
                onClick={() => generateMut.mutate()}
                disabled={generateMut.isPending}
              >
                {generateMut.isPending ? '生成中...' : '生成内容'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <ScriptEditor
              paragraphs={paragraphs}
              activeId={activeParaId}
              onActivate={setActiveParaId}
              onChange={handleParaChange}
            />
            <PreviewPanel
              visual={activeVisual}
              ttsText={activeTts?.text ?? null}
              ttsAsset={activeTts?.asset ?? null}
              onRegenerate={handleRegenerate}
            />
          </>
        )}
      </div>

      {timeline && (
        <div className="editor-footer">
          <span className="editor-footer-status">{readyCount}/{totalCount} 段就绪</span>
          <div className="editor-footer-actions">
            <button
              className="btn btn-sm"
              onClick={() => confirmMut.mutate()}
              disabled={confirmMut.isPending}
            >
              {confirmMut.isPending ? '确认中...' : '全部确认'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => exportMut.mutate()}
              disabled={exportMut.isPending}
            >
              {exportMut.isPending ? '导出中...' : '导出剪映'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => renderMut.mutate()}
              disabled={renderMut.isPending}
            >
              {renderMut.isPending ? '生成中...' : '生成视频'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
