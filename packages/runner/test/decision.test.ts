import { describe, expect, it } from "vitest";
import { extractJson, parseDecision } from "../src/llm/decision.js";

describe("parsing the AI answer (AgentDecision)", () => {
  it("valid JSON; limitPriceUsd null -> field omitted", () => {
    const r = parseDecision('{"actions":[{"type":"buy","market":"NVDA","sizeBps":500,"limitPriceUsd":null,"reason":"pullback"}],"note":"ok"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ actions: [{ type: "buy", market: "NVDA", sizeBps: 500, reason: "pullback" }], note: "ok" });
  });
  it("JSON inside a markdown block and surrounded by text", () => {
    expect(parseDecision('Here is my decision:\n```json\n{"actions":[],"note":"hold"}\n```').ok).toBe(true);
    expect(parseDecision('Thinking... {"actions":[],"note":"a } brace inside a string"} done').ok).toBe(true);
  });
  it("normalization: sizeBps is rounded and clamped, reason is truncated", () => {
    const r = parseDecision({ actions: [{ type: "sell", market: "NVDA", sizeBps: 12000.7, reason: "x".repeat(500) }], note: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actions[0]!.sizeBps).toBe(10000);
      expect(r.value.actions[0]!.reason.length).toBe(280);
    }
  });
  it("invalid: unknown type, more than 3 actions, negative price, no actions", () => {
    expect(parseDecision('{"actions":[{"type":"short","market":"NVDA","sizeBps":1,"reason":""}],"note":""}').ok).toBe(false);
    const four = Array.from({ length: 4 }, () => ({ type: "hold", market: "", sizeBps: 0, reason: "" }));
    expect(parseDecision({ actions: four, note: "" }).ok).toBe(false);
    expect(parseDecision({ actions: [{ type: "buy", market: "NVDA", sizeBps: 1, limitPriceUsd: -1, reason: "" }], note: "" }).ok).toBe(false);
    expect(parseDecision({ note: "x" }).ok).toBe(false);
  });
  it("garbage -> a parse error, never an exception", () => {
    for (const g of ["", "I cannot help", "{not json", "[1,2,3]", "null", '{"actions": "buy everything"}']) {
      expect(parseDecision(g).ok).toBe(false);
    }
    expect(() => extractJson("{{{{")).toThrow();
  });
});
