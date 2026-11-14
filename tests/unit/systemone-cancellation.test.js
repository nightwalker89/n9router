import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
const opts = { body: { state: "test", questions: { route: { type: "choice", criteria: { a: "A" } } } }, modelInfo: { provider: "ollama-local", model: "clef-flash" }, credentials: {} };
afterEach(() => vi.unstubAllGlobals());
describe("System One cancellation", () => {
  it("forwards caller cancellation to the upstream fetch", async () => {
    const controller = new AbortController();
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((resolve, reject) => {
      upstreamSignal = options.signal;
      upstreamSignal.addEventListener("abort", () => reject(upstreamSignal.reason), { once: true });
    })));
    const pending = handleSystemoneCore({ ...opts, signal: controller.signal });
    controller.abort(new Error("router budget exhausted"));
    expect(upstreamSignal.aborted).toBe(true);
    expect((await pending).success).toBe(false);
  });
  it("does not send a request when the caller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await handleSystemoneCore({ ...opts, signal: controller.signal })).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
