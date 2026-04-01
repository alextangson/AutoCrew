/**
 * EventBus — lightweight event system for AutoCrew workflow automation.
 *
 * Inspired by Claude Code's async events (FileChanged, CwdChanged).
 * Tools emit events, hooks subscribe to them.
 */

// --- Event Types ---

export type AutoCrewEventType =
  | "tool:pre_execute"
  | "tool:post_execute"
  | "tool:execute_failed"
  | "content:created"
  | "content:updated"
  | "content:status_changed"
  | "content:edited"
  | "topic:created"
  | "cover:candidates_created"
  | "cover:approved"
  | "review:completed"
  | "rule:distilled"
  | "session:started"
  | "session:ended";

export interface AutoCrewEvent {
  type: AutoCrewEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventHandler = (event: AutoCrewEvent) => void | Promise<void>;

export interface EventSubscription {
  id: string;
  type: AutoCrewEventType | "*";
  handler: EventHandler;
}

// --- Factory ---

export function createEvent(type: AutoCrewEventType, data: Record<string, unknown> = {}): AutoCrewEvent {
  return { type, timestamp: new Date().toISOString(), data };
}

// --- EventBus ---

export class EventBus {
  private subscriptions: EventSubscription[] = [];
  private history: AutoCrewEvent[] = [];
  private maxHistory = 200;

  /** Subscribe to a specific event type, or "*" for all events */
  on(type: AutoCrewEventType | "*", handler: EventHandler): string {
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.subscriptions.push({ id, type, handler });
    return id;
  }

  /** Unsubscribe by subscription id */
  off(id: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
  }

  /** Emit an event to all matching subscribers */
  emit(event: AutoCrewEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    for (const sub of this.subscriptions) {
      if (sub.type === "*" || sub.type === event.type) {
        try {
          // Fire and forget — don't block the tool pipeline
          const result = sub.handler(event);
          if (result instanceof Promise) {
            result.catch(() => {}); // Swallow async errors in handlers
          }
        } catch {
          // Swallow sync errors in handlers
        }
      }
    }
  }

  /** Get recent event history */
  getHistory(limit?: number): AutoCrewEvent[] {
    const n = limit || 50;
    return this.history.slice(-n);
  }

  /** Get history filtered by event type */
  getHistoryByType(type: AutoCrewEventType, limit?: number): AutoCrewEvent[] {
    const n = limit || 50;
    return this.history.filter((e) => e.type === type).slice(-n);
  }

  /** Clear all subscriptions and history */
  reset(): void {
    this.subscriptions = [];
    this.history = [];
  }
}
