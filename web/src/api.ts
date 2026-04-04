const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
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
  return request<unknown[]>('/contents');
}

export async function fetchContent(id: string) {
  return request<unknown>(`/contents/${id}`);
}

export async function fetchTopics() {
  return request<unknown[]>('/topics');
}

export async function fetchWorkflows() {
  return request<unknown[]>('/workflows');
}

export async function fetchWorkflowTemplates() {
  return request<unknown[]>('/workflows/templates');
}

export async function createWorkflow(templateId: string, params?: Record<string, unknown>) {
  return request<unknown>('/workflows', {
    method: 'POST',
    body: JSON.stringify({ templateId, ...params }),
  });
}

export async function startWorkflow(id: string) {
  return request<unknown>(`/workflows/${id}/start`, { method: 'POST' });
}

export async function approveWorkflow(id: string) {
  return request<unknown>(`/workflows/${id}/approve`, { method: 'POST' });
}

export async function cancelWorkflow(id: string) {
  return request<unknown>(`/workflows/${id}/cancel`, { method: 'POST' });
}

export async function fetchWorkflowStatus(id: string) {
  return request<unknown>(`/workflows/${id}`);
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
