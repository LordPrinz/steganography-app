import { describe, expect, test } from "bun:test";
import { ipBucket, normalizeIp } from "./client-ip.ts";

describe("normalizeIp", () => {
  test("unwraps IPv4-mapped IPv6, drops zones and lowercases", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::FFFF:10.0.0.5")).toBe("10.0.0.5");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80::1");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("ipBucket", () => {
  test("keeps IPv4 addresses as they are", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
  });

  test("maps every IPv6 address to its /64 prefix", () => {
    expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("::1.2.3.4")).toBe("0:0:0:0::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
  });

  test("passes anything that is not an IP through", () => {
    expect(ipBucket("")).toBe("");
  });
});
