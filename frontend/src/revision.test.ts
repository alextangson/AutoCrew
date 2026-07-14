import { describe, it, expect, beforeEach } from "vitest";
import { getFocus, setFocus, clearFocus, getProposal, setProposal, clearProposal, subscribe } from "./revision";

beforeEach(() => clearFocus());

describe("revision store", () => {
  it("setFocus / getFocus and notifies subscribers", () => {
    let n = 0;
    const off = subscribe(() => n++);
    setFocus({ contentId: "c1", scope: "draft" });
    expect(getFocus()).toMatchObject({ contentId: "c1", scope: "draft" });
    expect(n).toBe(1);
    off();
  });

  it("changing focus clears any prior proposal", () => {
    setFocus({ contentId: "c1", scope: "draft" });
    setProposal({ contentId: "c1", scope: "draft", body: "x" });
    expect(getProposal()).not.toBeNull();
    setFocus({ contentId: "c2", scope: "draft" });
    expect(getProposal()).toBeNull();
  });

  it("clearProposal keeps the focus", () => {
    setFocus({ contentId: "c1", scope: "selection", selection: { start: 0, end: 3, text: "abc" } });
    setProposal({ contentId: "c1", scope: "selection", span: "xyz" });
    clearProposal();
    expect(getProposal()).toBeNull();
    expect(getFocus()).not.toBeNull();
  });
});
