import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus, createEvent } from "../runtime/events.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("emits events to matching subscribers", () => {
    const handler = vi.fn();
    bus.on("content:created", handler);
    bus.emit(createEvent("content:created", { contentId: "c1" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].data.contentId).toBe("c1");
  });

  it("does not fire handler for non-matching events", () => {
    const handler = vi.fn();
    bus.on("content:created", handler);
    bus.emit(createEvent("content:updated", { contentId: "c1" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("wildcard * matches all events", () => {
    const handler = vi.fn();
    bus.on("*", handler);
    bus.emit(createEvent("content:created", {}));
    bus.emit(createEvent("tool:pre_execute", {}));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes by id", () => {
    const handler = vi.fn();
    const id = bus.on("content:created", handler);
    bus.off(id);
    bus.emit(createEvent("content:created", {}));
    expect(handler).not.toHaveBeenCalled();
  });

  it("records event history", () => {
    bus.emit(createEvent("content:created", { id: "1" }));
    bus.emit(createEvent("content:updated", { id: "2" }));
    const history = bus.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].type).toBe("content:created");
  });

  it("filters history by type", () => {
    bus.emit(createEvent("content:created", {}));
    bus.emit(createEvent("tool:pre_execute", {}));
    bus.emit(createEvent("content:created", {}));
    const filtered = bus.getHistoryByType("content:created");
    expect(filtered).toHaveLength(2);
  });

  it("caps history at maxHistory", () => {
    for (let i = 0; i < 250; i++) {
      bus.emit(createEvent("content:created", { i }));
    }
    expect(bus.getHistory(300).length).toBeLessThanOrEqual(200);
  });

  it("swallows sync errors in handlers", () => {
    bus.on("content:created", () => { throw new Error("boom"); });
    expect(() => bus.emit(createEvent("content:created", {}))).not.toThrow();
  });

  it("reset clears subscriptions and history", () => {
    const handler = vi.fn();
    bus.on("content:created", handler);
    bus.emit(createEvent("content:created", {}));
    expect(handler).toHaveBeenCalledTimes(1);

    bus.reset();
    expect(bus.getHistory()).toHaveLength(0);

    // After reset, handler should no longer fire
    bus.emit(createEvent("content:created", {}));
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2
  });
});
