import { describe, it, expect } from "vitest";
import { bindAddressError, isLoopbackAddress, listenAddress } from "@/lib/bindAddress";

describe("bindAddressError", () => {
  it.each(["", "  ", "127.0.0.1", " 192.168.1.5 ", "0.0.0.0", "255.255.255.255", "::1", "::", "fe80::1", "2001:db8::2"])(
    "accepts %j",
    (text) => expect(bindAddressError(text)).toBeNull(),
  );

  it.each(["localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.0.0.1", "01.2.3.4", "127.0.0.1:80", "[::1]", "1:2", "fe80::1%en0", "::1/64"])(
    "refuses %j",
    (text) => expect(bindAddressError(text)).toMatch(/IP address/),
  );
});

describe("isLoopbackAddress", () => {
  it.each(["", " ", "127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1"])("%j reaches only this computer", (text) =>
    expect(isLoopbackAddress(text)).toBe(true),
  );

  it.each(["0.0.0.0", "::", "192.168.1.5", "128.0.0.1", "fe80::1"])("%j can be reached from elsewhere", (text) =>
    expect(isLoopbackAddress(text)).toBe(false),
  );
});

describe("listenAddress", () => {
  it("falls back on loopback and puts brackets around IPv6", () => {
    expect(listenAddress({ local_port: 80 })).toBe("127.0.0.1:80");
    expect(listenAddress({ bind_address: "", local_port: 80 })).toBe("127.0.0.1:80");
    expect(listenAddress({ bind_address: "10.0.0.5", local_port: 80 })).toBe("10.0.0.5:80");
    expect(listenAddress({ bind_address: "::1", local_port: 80 })).toBe("[::1]:80");
  });
});
