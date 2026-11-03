import { describe, it, expect } from "vitest";
import { parsePort } from "@/lib/port";

describe("parsePort", () => {
  it("returns null/null for empty / undefined / null input", () => {
    expect(parsePort("")).toEqual({ value: null, error: null });
    expect(parsePort("   ")).toEqual({ value: null, error: null });
    expect(parsePort(undefined)).toEqual({ value: null, error: null });
    expect(parsePort(null)).toEqual({ value: null, error: null });
  });

  it("parses a valid port number", () => {
    expect(parsePort("22")).toEqual({ value: 22, error: null });
    expect(parsePort("1")).toEqual({ value: 1, error: null });
    expect(parsePort("65535")).toEqual({ value: 65535, error: null });
    expect(parsePort(2200)).toEqual({ value: 2200, error: null });
  });

  it("rejects out-of-range integers", () => {
    expect(parsePort("0").error).toMatch(/between/);
    expect(parsePort("0").value).toBeNull();
    expect(parsePort("65536").error).toMatch(/between/);
    expect(parsePort("100000").error).toMatch(/between/);
  });

  it("rejects non-integer / non-numeric input", () => {
    expect(parsePort("22.5").error).toMatch(/whole number/);
    expect(parsePort("abc").error).toMatch(/whole number/);
    expect(parsePort("22a").error).toMatch(/whole number/);
    expect(parsePort("-22").error).toMatch(/whole number/);
    expect(parsePort("+22").error).toMatch(/whole number/);
    expect(parsePort("0x22").error).toMatch(/whole number/);
  });
});
