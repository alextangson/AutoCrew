const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchTools() {
  return request<unknown[]>('/tools');
}

export async function executeTool(name: string, params: Record<string, unknown>) {
  return request<unknown>(`/tools/${name}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function fetchContents() {
  const res = await request<{ ok: boolean; contents: unknown[] }>('/contents');
  return res.contents ?? [];
}

export async function fetchContent(id: string) {
  const res = await request<{ ok: boolean; content: unknown }>(`/contents/${id}`);
  return res.content ?? res;
}

export async function fetchTopics() {
  const res = await request<{ ok: boolean; topics: unknown[] }>('/topics');
  return res.topics ?? [];
}

export async function fetchStatus() {
  return request<unknown>('/status');
}

export async function getTimeline(contentId: string) {
  return request<{ ok: boolean; timeline: any }>(`/contents/${contentId}/timeline`);
}

export async function generateTimeline(contentId: string, preset: string, aspectRatio: string) {
  return request<{ ok: boolean; timeline: any }>(`/contents/${contentId}/timeline`, {
    method: 'POST',
    body: JSON.stringify({ preset, aspectRatio }),
  });
}

export async function updateSegment(contentId: string, segmentId: string, updates: { status?: string; assetPath?: string }) {
  return request<{ ok: boolean }>(`/contents/${contentId}/timeline/segments/${segmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function confirmAllSegments(contentId: string) {
  return request<{ ok: boolean }>(`/contents/${contentId}/timeline/confirm-all`, {
    method: 'POST',
  });
}

export async function createContentFromTopic(topicId: string) {
  return request<{ id: string }>('/contents', {
    method: 'POST',
    body: JSON.stringify({ topicId }),
  });
}

export async function updateContentStatus(id: string, status: string) {
  return request<unknown>(`/contents/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

import { useEffect, useRef } from 'react';

export function useEventStream(onEvent: (event: Record<string, unknown>) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource(`${BASE}/events`);

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current(data);
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);
}
