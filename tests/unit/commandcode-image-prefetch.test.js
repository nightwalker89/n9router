/**
 * CommandCode: remote image URLs must be inlined as base64 BEFORE the request
 * reaches upstream. CommandCode accepts an https URL inside an image part but
 * its backend cannot fetch it ("Failed to download image from ..."), so
 * FORMATS.COMMANDCODE belongs in prefetch.js's TARGETS_NEED_BASE64.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../open-sse/translator/concerns/image.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchImageAsBase64: vi.fn(async () => ({
      url: "data:image/png;base64,STUBBED",
      mimeType: "image/png",
    })),
  };
});

import { prefetchRemoteImages } from "../../open-sse/translator/concerns/prefetch.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const bodyWithRemoteImage = () => ({
  messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
  ] }],
});

describe("prefetchRemoteImages — commandcode target", () => {
  it("inlines a remote image URL as base64 for the commandcode target", async () => {
    const body = bodyWithRemoteImage();
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE, {});

    expect(n).toBe(1);
    expect(body.messages[0].content[1].image_url.url).toBe("data:image/png;base64,STUBBED");
  });

  it("leaves the URL alone for a target that accepts remote URLs", async () => {
    const body = bodyWithRemoteImage();
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OPENAI, {});

    expect(n).toBe(0);
    expect(body.messages[0].content[1].image_url.url).toBe("https://example.com/pic.png");
  });

  it("prefetch -> translate round-trips a flat-string image_url without losing the image", async () => {
    // Regression: prefetch rewrites a flat-string image_url in place, so the
    // translator must accept that shape or the image is fetched then discarded.
    const { openaiToCommandCodeRequest } = await import(
      "../../open-sse/translator/request/openai-to-commandcode.js");

    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: "https://example.com/pic.png" },
    ] }] };

    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE, {});
    expect(n).toBe(1);
    expect(body.messages[0].content[0].image_url).toBe("data:image/png;base64,STUBBED");

    const out = openaiToCommandCodeRequest("m", body, true);
    expect(out.params.messages[0].content).toEqual([
      { type: "image", image: "data:image/png;base64,STUBBED" },
    ]);
  });

  it("leaves an already-inline data URI untouched", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE, {});

    expect(n).toBe(0);
    expect(body.messages[0].content[0].image_url.url).toBe("data:image/png;base64,AAAA");
  });
});
