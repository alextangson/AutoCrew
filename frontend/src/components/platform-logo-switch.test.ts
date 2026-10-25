// @vitest-environment happy-dom
/** 平台 logo（内嵌 Simple Icons 字形 + 无来源平台单字兜底）与开关/勾选框的语义 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SEAT_CHOICES } from "../lib";
import { PlatformLogo, hasPlatformLogo } from "./PlatformLogo";
import { Checkbox, Radio, Switch } from "./Switch";

const html = (n: ReturnType<typeof createElement>) => renderToStaticMarkup(n);

describe("PlatformLogo", () => {
  it("每个运营平台都有标记，且只有视频号、头条走单字兜底", () => {
    const fallback = SEAT_CHOICES.filter((c) => !hasPlatformLogo(c.id)).map((c) => c.id).sort();
    expect(fallback).toEqual(["toutiao", "wechat_video"]);
    for (const c of SEAT_CHOICES) expect(html(createElement(PlatformLogo, { id: c.id, label: c.label }))).toContain("platform-logo");
  });
  it("有 logo 的出内嵌 svg、不引外部地址；兜底出单字；都对读屏隐藏", () => {
    const yt = html(createElement(PlatformLogo, { id: "youtube", label: "YouTube" }));
    expect(yt).toContain("<svg");
    expect(yt).not.toMatch(/https?:|<img/);
    const tt = html(createElement(PlatformLogo, { id: "toutiao", label: "头条" }));
    expect(tt).not.toContain("<svg");
    expect(tt).toContain(">头<");
    expect(html(createElement(PlatformLogo, { id: "mystery", label: "某平台" }))).toContain(">某<");
    expect(yt).toContain('aria-hidden="true"');
  });
});

describe("Switch / Checkbox / Radio", () => {
  it("开关是 role=switch 的原生 checkbox，aria-checked 跟着 checked", () => {
    const on = html(createElement(Switch, { checked: true, readOnly: true }));
    expect(on).toMatch(/type="checkbox"/);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("ui-switch");
  });
  it("勾选框与单选保持原生角色", () => {
    const c = html(createElement(Checkbox, { checked: false, readOnly: true, className: "x" }));
    expect(c).not.toContain("role=");
    expect(c).toContain('class="ui-check x"');
    expect(html(createElement(Radio, { name: "k", readOnly: true }))).toContain('type="radio"');
  });
});
