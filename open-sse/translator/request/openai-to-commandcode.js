/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - image blocks (role=user): {type:"image", image:"data:<mime>;base64,<data>"}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 *
 * Image support verified live against /alpha/generate (2026-09-04): an AI SDK v5
 * `image` part carrying a data URL (or bare base64 + mediaType) is accepted; AI SDK
 * `file` parts and OpenAI `image_url` parts are both rejected with HTTP 400. A remote
 * https URL passes validation but the backend cannot fetch it, so chatCore prefetches
 * remote images to base64 first (FORMATS.COMMANDCODE is in TARGETS_NEED_BASE64).
 * Models without vision still get the text placeholder, but that decision belongs to
 * stripUnsupportedModalities upstream — not to this translator.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

// OpenAI/Claude-shaped image part -> AI SDK v5 image part. Returns null when no
// usable source is present, so the caller can fall back to the text placeholder.
function toImagePart(part) {
  // `image_url` is either {url} or a flat string. Both shapes occur here — see
  // prefetch.js, which rewrites a flat string in place, so a prefetched remote
  // image arrives as a bare data-URI string and would otherwise be dropped
  // after having already been fetched over the network.
  const imageUrl = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
  const direct = imageUrl ?? part?.image ?? part?.url;
  if (typeof direct === "string" && direct) {
    // Upstream does accept bare base64 with no mediaType (verified), but when the
    // caller states a type, keep it rather than making upstream sniff the bytes.
    const isUri = /^(data:|https?:)/.test(direct);
    const mime = part?.mediaType || part?.media_type || "image/png";
    return { type: OPENAI_BLOCK.IMAGE, image: isUri ? direct : `data:${mime};base64,${direct}` };
  }
  const src = part?.source;
  if (src?.type === "base64" && src.data) {
    return { type: OPENAI_BLOCK.IMAGE, image: `data:${src.media_type || "image/png"};base64,${src.data}` };
  }
  if (src?.type === "url" && typeof src.url === "string" && src.url) {
    return { type: OPENAI_BLOCK.IMAGE, image: src.url };
  }
  return null;
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL || part.type === OPENAI_BLOCK.IMAGE) {
          blocks.push(toImagePart(part) || { type: OPENAI_BLOCK.TEXT, text: "[image omitted]" });
        } else if (typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      out.push({
        role: ROLE.TOOL,
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: m.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const blocks = [];
      const text = flattenText(m.content);
      if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: ROLE.ASSISTANT, content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }] });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeRequest(model, body, stream /* , credentials */) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  const today = new Date().toISOString().slice(0, 10);

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null);
