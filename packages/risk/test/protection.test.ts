import { PRESETS } from "@glint/strategy";
import { describe, expect, it } from "vitest";
import { avgEntryFromTrades, checkProtection, nearProtection, updatePeaks } from "../src/index.js";

const protect = PRESETS.find((p) => p.key === "protect")!;
const params = { stopLossPct: 10, takeProfitPct: 20, trailingPct: 5 };

describe("protective stops (executed by code)", () => {
  it("stop-loss / take-profit / trailing / nothing", () => {
    const pos = [{ market: "NVDA", qty: 1, entryPx: 100 }];
    expect(checkProtection(protect, params, pos, { NVDA: 89 })[0].kind).toBe("stop_loss");
    expect(checkProtection(protect, params, pos, { NVDA: 121 })[0].kind).toBe("take_profit");
    expect(checkProtection(protect, params, pos, { NVDA: 110 }, { NVDA: 118 })[0].kind).toBe("trailing");
    expect(checkProtection(protect, params, pos, { NVDA: 105 }, { NVDA: 106 })).toEqual([]);
    expect(checkProtection({ ...protect, protection: undefined }, params, pos, { NVDA: 1 })).toEqual([]);
    expect(nearProtection(protect, params, pos, { NVDA: 90.5 })).toBe(true);
  });

  it("a preset that cannot sell never triggers stops", () => {
    const pos = [{ market: "NVDA", qty: 1, entryPx: 100 }];
    expect(checkProtection({ ...protect, allowsSell: false }, params, pos, { NVDA: 50 })).toEqual([]);
  });

  it("peaks track open positions and reset on close", () => {
    const pos = [{ market: "NVDA", qty: 1, entryPx: 100 }];
    expect(updatePeaks({}, pos, { NVDA: 105 })).toEqual({ NVDA: 105 });
    expect(updatePeaks({ NVDA: 110 }, pos, { NVDA: 105 })).toEqual({ NVDA: 110 });
    expect(updatePeaks({ NVDA: 110 }, [{ market: "NVDA", qty: 0, entryPx: null }], { NVDA: 105 })).toEqual({});
  });

  it("average entry price from the trade history", () => {
    const t = [
      { side: "buy" as const, market: "NVDA", sizeBase: 1, price: 10 },
      { side: "buy" as const, market: "NVDA", sizeBase: 1, price: 20 },
      { side: "sell" as const, market: "NVDA", sizeBase: 1, price: 30 },
    ];
    expect(avgEntryFromTrades(t, "NVDA")).toEqual({ qty: 1, avgPx: 15 });
    expect(avgEntryFromTrades(t, "SPY")).toEqual({ qty: 0, avgPx: null });
  });
});
