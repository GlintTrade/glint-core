import { describe, expect, it } from "vitest";
import { formatSpotPrice, formatSpotSize, slippageLimitPrice, toScaledInt } from "../src/format.js";

describe("Lighter integer prices and sizes (price_decimals / size_decimals)", () => {
  it("price: at most priceDecimals decimals, directional rounding", () => {
    expect(formatSpotPrice(176.0549, 2, "down")).toBe("176.05");
    expect(formatSpotPrice(176.0501, 2, "up")).toBe("176.06");
    expect(formatSpotPrice(176.005, 2, "nearest")).toBe("176.01");
    expect(formatSpotPrice(1.005, 3, "nearest")).toBe("1.005");
    expect(formatSpotPrice(0.012345, 5, "down")).toBe("0.01234");
    expect(formatSpotPrice(123456.7, 0, "down")).toBe("123456");
    expect(formatSpotPrice(9.999, 2, "up")).toBe("10");
    expect(() => formatSpotPrice(0.001, 2, "down")).toThrow();
  });
  it("size rounds down to szDecimals", () => {
    expect(formatSpotSize(1.23456789, 4)).toBe("1.2345");
    expect(formatSpotSize(0.1999999, 2)).toBe("0.19");
    expect(formatSpotSize(5, 0)).toBe("5");
    expect(formatSpotSize(0.004, 2)).toBe("0");
  });
  it("IOC limit: buy ≤ mid*(1+s), sell ≥ mid*(1-s)", () => {
    const b = Number(slippageLimitPrice(176.4321, "buy", 100, 2));
    const s = Number(slippageLimitPrice(176.4321, "sell", 100, 2));
    expect(b).toBeLessThanOrEqual(176.4321 * 1.01);
    expect(s).toBeGreaterThanOrEqual(176.4321 * 0.99);
    expect(b).toBe(178.19);
    expect(s).toBe(174.67);
  });
  it("to integers for the signer: exact, no float (size × 10^size_decimals, price × 10^price_decimals)", () => {
    expect(toScaledInt("0.05", 4)).toBe(500);
    expect(toScaledInt("3150", 2)).toBe(315000);
    expect(toScaledInt("176.05", 2)).toBe(17605);
    expect(toScaledInt("4.95", 2)).toBe(495);
    expect(toScaledInt("0.1", 1)).toBe(1);
    expect(() => toScaledInt("1.234", 2)).toThrow();
    expect(() => toScaledInt("-1", 2)).toThrow();
    expect(() => toScaledInt("1e3", 2)).toThrow();
  });
});
