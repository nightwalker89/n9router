import { describe, expect, it, vi, beforeEach } from "vitest";
import dns from "dns";
import { promisify } from "util";

// Mock the dns module
vi.mock("dns", () => ({
  default: {
    Resolver: vi.fn(),
  },
}));

describe("MITM DNS resolution with IP addresses", () => {
  let mockResolver;
  let mockResolve4;

  beforeEach(() => {
    mockResolve4 = vi.fn();
    mockResolver = {
      setServers: vi.fn(),
      resolve4: vi.fn((hostname, callback) => {
        mockResolve4(hostname, callback);
      }),
    };
    dns.Resolver = vi.fn(() => mockResolver);
  });

  function isIPAddress(hostname) {
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname);
  }

  async function resolveTargetIP(hostname) {
    if (isIPAddress(hostname)) {
      return hostname;
    }
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8"]);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    return addresses[0];
  }

  it("detects IPv4 addresses correctly", () => {
    expect(isIPAddress("192.168.1.83")).toBe(true);
    expect(isIPAddress("127.0.0.1")).toBe(true);
    expect(isIPAddress("10.0.0.1")).toBe(true);
    expect(isIPAddress("255.255.255.255")).toBe(true);
  });

  it("detects IPv6 addresses correctly", () => {
    expect(isIPAddress("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
    expect(isIPAddress("::1")).toBe(true);
    expect(isIPAddress("fe80::1")).toBe(true);
  });

  it("rejects domain names", () => {
    expect(isIPAddress("daily-cloudcode-pa.googleapis.com")).toBe(false);
    expect(isIPAddress("api.individual.githubcopilot.com")).toBe(false);
    expect(isIPAddress("localhost")).toBe(false);
    expect(isIPAddress("example.com")).toBe(false);
  });

  it("returns IP address directly without DNS lookup", async () => {
    const result = await resolveTargetIP("192.168.1.83");
    expect(result).toBe("192.168.1.83");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("performs DNS lookup for domain names", async () => {
    mockResolve4.mockImplementation((hostname, callback) => {
      callback(null, ["142.250.185.46"]);
    });

    const result = await resolveTargetIP("daily-cloudcode-pa.googleapis.com");
    expect(result).toBe("142.250.185.46");
    expect(mockResolve4).toHaveBeenCalledWith(
      "daily-cloudcode-pa.googleapis.com",
      expect.any(Function)
    );
  });
});
