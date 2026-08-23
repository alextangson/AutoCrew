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

  it("publish:confirm 的 publish_url 是可选键——不带链接的确认照样过契约", () => {
    expect(validatePayload("publish:confirm", { content_id: "c1" })).toBeNull();
    expect(validatePayload("publish:confirm", { content_id: "c1", publish_url: "https://x/y" })).toBeNull();
  });

  it("publish:pre_check 必须带 content_id", () => {
    expect(validatePayload("publish:pre_check", {})).toContain("content_id");
    expect(validatePayload("publish:pre_check", { content_id: "c1" })).toBeNull();
  });

  it("自动回流控制面：pull_now 必带 platform，pull_toggle 的 enabled=false 也算给了值", () => {
    expect(validatePayload("flywheel:pull_status", {})).toBeNull();
    expect(validatePayload("flywheel:pull_now", {})).toContain("platform");
    expect(validatePayload("flywheel:pull_now", { platform: "douyin" })).toBeNull();
    expect(validatePayload("flywheel:pull_toggle", { platform: "douyin" })).toContain("enabled");
    expect(validatePayload("flywheel:pull_toggle", { platform: "douyin", enabled: false })).toBeNull();
  });

  it("rejects unregistered channels", () => {
    expect(validatePayload("made:up", {})).toContain("未在 channel-contracts 登记");
  });
});
