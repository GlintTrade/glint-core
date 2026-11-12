import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, DEFAULT_WEB_URL, loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("defaults the website to https://tradeglint.xyz", () => {
    expect(DEFAULT_WEB_URL).toBe("https://tradeglint.xyz");
    expect(loadConfig({}).webUrl).toBe("https://tradeglint.xyz");
    expect(loadConfig({ GLINT_WEB_URL: "  " }).webUrl).toBe("https://tradeglint.xyz");
  });
  it("GLINT_WEB_URL overrides the default (trailing slash trimmed)", () => {
    expect(loadConfig({ GLINT_WEB_URL: "http://localhost:5173/" }).webUrl).toBe("http://localhost:5173");
  });
  it("defaults the API to a local backend; GLINT_API_URL overrides it", () => {
    expect(DEFAULT_API_URL).toBe("http://localhost:8787");
    expect(loadConfig({}).apiUrl).toBe("http://localhost:8787");
    expect(loadConfig({ GLINT_API_URL: "https://api.example.test/" }).apiUrl).toBe("https://api.example.test");
  });
  it("accepts the earlier ELYSIUM_* names; GLINT_* takes precedence", () => {
    expect(loadConfig({ ELYSIUM_API_KEY: "ek_old" }).apiKey).toBe("ek_old");
    expect(loadConfig({ ELYSIUM_API_KEY: "ek_old", GLINT_API_KEY: "ek_new" }).apiKey).toBe("ek_new");
    expect(loadConfig({ GLINT_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
    expect(loadConfig({}).timeoutMs).toBe(60_000);
  });
});
