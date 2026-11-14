import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ model: vi.fn(), credentials: vi.fn(), refresh: vi.fn(), core: vi.fn() }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.model }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: mocks.credentials }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: mocks.refresh }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.core }));
import { resolveSmartChoice } from "../../src/sse/services/systemoneRouter.js";
const opts = { body: { messages: [{ role: "user", content: "hello" }] }, models: ["a/a", "b/b"], timeoutMs: 10 };
const routeResponse = () => ({ success: true, response: Response.json({ answers: { route: { choice: "a/a", confidence: 0.9 } } }) });
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  mocks.model.mockResolvedValue({ provider: "opencode", model: "jev" });
  mocks.credentials.mockResolvedValue({ accessToken: "test" });
  mocks.refresh.mockResolvedValue({ accessToken: "fresh" });
  mocks.core.mockImplementation(async () => routeResponse());
});
afterEach(() => vi.useRealTimers());
describe("smart-router deadline", () => {
  it.each(["model", "credentials", "refresh"])("bounds %s resolution and prevents late dispatch", async stage => {
    let release;
    mocks[stage].mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let result = "pending";
    const pending = resolveSmartChoice(opts).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toBeNull();
    expect(mocks.core).not.toHaveBeenCalled();
    release({ provider: "opencode", model: "jev", accessToken: "test" });
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(mocks.core).not.toHaveBeenCalled();
  });
  it("aborts upstream work when the total budget expires", async () => {
    let signal;
    mocks.core.mockImplementationOnce(options => { signal = options.signal; return new Promise(() => {}); });
    const pending = resolveSmartChoice(opts);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeNull();
    expect(signal.aborted).toBe(true);
  });
  it("bounds response parsing too", async () => {
    mocks.core.mockResolvedValueOnce({ success: true, response: { json: () => new Promise(() => {}) } });
    let result = "pending";
    const pending = resolveSmartChoice(opts).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toBeNull();
    await pending;
  });
  it("returns a successful route and clears the deadline", async () => {
    expect(await resolveSmartChoice(opts)).toMatchObject({ choice: "a/a", confidence: 0.9 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
