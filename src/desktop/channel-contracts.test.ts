import { describe, it, expect } from "vitest";
import { REQUIRED_FIELDS, validatePayload } from "./channel-contracts.js";
import { IPC_CHANNELS } from "./channels.js";

describe("channel contracts", () => {
  it("covers every IPC channel exactly — adding a channel without registering here fails", () => {
    expect(Object.keys(REQUIRED_FIELDS).sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("rejects missing required fields with a named error", () => {
    expect(validatePayload("content:get", {})).toContain("id");
    expect(validatePayload("chat:turn", { message: "  " })).toContain("message");
    expect(validatePayload("content:transition", { id: "c1" })).toContain("target_status");
  });

  it("passes when required fields are present; empty-required channels always pass", () => {
    expect(validatePayload("content:get", { id: "c1" })).toBeNull();
    expect(validatePayload("topics:list", {})).toBeNull();
  });

  it("rejects unregistered channels", () => {
    expect(validatePayload("made:up", {})).toContain("未在 channel-contracts 登记");
  });
});
