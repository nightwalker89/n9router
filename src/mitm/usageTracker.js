const zlib = require("zlib");
const { log, err } = require("./logger");

const INTERNAL_USAGE_URL = process.env.ROUTER_USAGE_URL || "http://127.0.0.1:20128/api/internal/usage";
const INTERNAL_REQUEST_DETAIL_URL = process.env.ROUTER_REQUEST_DETAIL_URL || "http://127.0.0.1:20128/api/internal/request-detail";
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };
const OPTIONAL_REQUEST_FIELDS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", usage.prompt_tokens);
  assignNumber("completion_tokens", usage.completion_tokens);
  assignNumber("total_tokens", usage.total_tokens);
  assignNumber("cache_read_input_tokens", usage.cache_read_input_tokens);
  assignNumber("cache_creation_input_tokens", usage.cache_creation_input_tokens);
  assignNumber("cached_tokens", usage.cached_tokens);
  assignNumber("reasoning_tokens", usage.reasoning_tokens);
  if (usage.estimated === true) normalized.estimated = true;

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object") return false;
  const fields = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "promptTokenCount",
    "candidatesTokenCount"
  ];

  return fields.some((field) => typeof usage[field] === "number" && usage[field] > 0);
}

function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  if (chunk.type === "message_delta" && chunk.usage && typeof chunk.usage === "object") {
    return normalizeUsage({
      prompt_tokens: chunk.usage.input_tokens || 0,
      completion_tokens: chunk.usage.output_tokens || 0,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
    });
  }

  if ((chunk.type === "response.completed" || chunk.type === "response.done") && chunk.response?.usage && typeof chunk.response.usage === "object") {
    const usage = chunk.response.usage;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: usage.input_tokens_details?.cached_tokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens
    });
  }

  if (chunk.usage && typeof chunk.usage === "object" && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens
    });
  }

  const usageMeta = chunk.usageMetadata || chunk.response?.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    return normalizeUsage({
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      total_tokens: usageMeta.totalTokenCount,
      cached_tokens: usageMeta.cachedContentTokenCount,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    });
  }

  return null;
}

function getPartsTextLength(parts) {
  if (!Array.isArray(parts)) return 0;
  return parts.reduce((total, part) => total + (typeof part?.text === "string" ? part.text.length : 0), 0);
}

function getOpenAIMessageTextLength(message) {
  if (!message) return 0;
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;

  return message.content.reduce((total, item) => {
    if (typeof item?.text === "string") return total + item.text.length;
    if (item?.type === "output_text" && typeof item?.text === "string") return total + item.text.length;
    return total;
  }, 0);
}

function extractContentLength(chunk) {
  if (!chunk || typeof chunk !== "object") return 0;

  let total = 0;

  if (typeof chunk.delta?.text === "string") total += chunk.delta.text.length;
  if (typeof chunk.delta?.thinking === "string") total += chunk.delta.thinking.length;
  if (typeof chunk.choices?.[0]?.delta?.content === "string") total += chunk.choices[0].delta.content.length;
  if (typeof chunk.choices?.[0]?.delta?.reasoning_content === "string") total += chunk.choices[0].delta.reasoning_content.length;
  if (chunk.choices?.[0]?.message) total += getOpenAIMessageTextLength(chunk.choices[0].message);
  if (Array.isArray(chunk.content)) {
    total += chunk.content.reduce((sum, item) => {
      if (typeof item?.text === "string") return sum + item.text.length;
      if (item?.type === "thinking" && typeof item?.thinking === "string") return sum + item.thinking.length;
      return sum;
    }, 0);
  }
  if (chunk.response?.output_text && typeof chunk.response.output_text === "string") total += chunk.response.output_text.length;
  if (chunk.response?.output && Array.isArray(chunk.response.output)) {
    total += chunk.response.output.reduce((sum, item) => sum + getOpenAIMessageTextLength(item), 0);
  }

  const geminiParts = chunk.candidates?.[0]?.content?.parts || chunk.response?.candidates?.[0]?.content?.parts;
  total += getPartsTextLength(geminiParts);

  return total;
}

function extractContentText(chunk) {
  if (!chunk || typeof chunk !== "object") return { content: "", thinking: "" };

  let content = "";
  let thinking = "";

  // Anthropic streaming
  if (typeof chunk.delta?.text === "string") content += chunk.delta.text;
  if (typeof chunk.delta?.thinking === "string") thinking += chunk.delta.thinking;

  // OpenAI streaming
  if (typeof chunk.choices?.[0]?.delta?.content === "string") content += chunk.choices[0].delta.content;
  if (typeof chunk.choices?.[0]?.delta?.reasoning_content === "string") thinking += chunk.choices[0].delta.reasoning_content;

  // OpenAI non-streaming
  if (chunk.choices?.[0]?.message) {
    const msg = chunk.choices[0].message;
    if (typeof msg.content === "string") content += msg.content;
    if (typeof msg.reasoning_content === "string") thinking += msg.reasoning_content;
  }

  // Anthropic content blocks
  if (Array.isArray(chunk.content)) {
    for (const item of chunk.content) {
      if (typeof item?.text === "string" && item?.type !== "thinking") content += item.text;
      if (item?.type === "thinking" && typeof item?.thinking === "string") thinking += item.thinking;
    }
  }

  // OpenAI Responses API
  if (chunk.response?.output_text && typeof chunk.response.output_text === "string") content += chunk.response.output_text;
  if (chunk.response?.output && Array.isArray(chunk.response.output)) {
    for (const item of chunk.response.output) {
      if (typeof item?.content === "string") content += item.content;
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string") content += part.text;
        }
      }
    }
  }

  // Gemini
  const geminiParts = chunk.candidates?.[0]?.content?.parts || chunk.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(geminiParts)) {
    for (const part of geminiParts) {
      if (part?.thought === true && typeof part?.text === "string") {
        thinking += part.text;
      } else if (typeof part?.text === "string") {
        content += part.text;
      }
    }
  }

  return { content, thinking };
}

function estimateInputTokens(body) {
  if (!body || typeof body !== "object") return 0;
  try {
    return Math.ceil(JSON.stringify(body).length / 4);
  } catch {
    return 0;
  }
}

function estimateOutputTokens(contentLength) {
  if (!contentLength || contentLength <= 0) return 0;
  return Math.max(1, Math.floor(contentLength / 4));
}

function estimateUsage(body, contentLength) {
  const promptTokens = estimateInputTokens(body);
  const completionTokens = estimateOutputTokens(contentLength);

  return normalizeUsage({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true
  });
}

function decodeResponseBody(rawBuffer, contentEncoding) {
  if (!rawBuffer || rawBuffer.length === 0) return "";

  try {
    if (!contentEncoding) {
      return rawBuffer.toString("utf-8");
    }

    const encoding = String(contentEncoding).toLowerCase();
    if (encoding.includes("gzip")) {
      return zlib.gunzipSync(rawBuffer).toString("utf-8");
    }
    if (encoding.includes("br")) {
      return zlib.brotliDecompressSync(rawBuffer).toString("utf-8");
    }
    if (encoding.includes("deflate")) {
      return zlib.inflateSync(rawBuffer).toString("utf-8");
    }

    return rawBuffer.toString("utf-8");
  } catch (error) {
    err(`[token-swap] failed to decode upstream body (${contentEncoding || "identity"}): ${error.message}`);
    return "";
  }
}

async function persistUsage(entry) {
  const response = await fetch(INTERNAL_USAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value
    },
    body: JSON.stringify(entry)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`usage persistence failed: ${response.status} ${text}`.trim());
  }
}

async function persistRequestDetail(entry) {
  const response = await fetch(INTERNAL_REQUEST_DETAIL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value
    },
    body: JSON.stringify(entry)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`request detail persistence failed: ${response.status} ${text}`.trim());
  }
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).slice(2, 8);
  const modelPart = model ? String(model).replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function extractText(instruction) {
  if (typeof instruction === "string") return instruction;
  if (instruction?.parts && Array.isArray(instruction.parts)) {
    return instruction.parts.map((part) => part?.text || "").join("");
  }
  return "";
}

function convertAntigravityContent(content) {
  const role = content?.role === "model" ? "assistant" : content?.role === "user" ? "user" : content?.role;
  if (!role || !Array.isArray(content?.parts)) return null;

  const textParts = [];
  const toolCalls = [];
  const toolResults = [];
  let reasoningContent = "";

  for (const part of content.parts) {
    if (part?.thought === true && part?.text) {
      reasoningContent += part.text;
      continue;
    }

    if (part?.thoughtSignature && part?.text !== undefined) {
      textParts.push({ type: "text", text: part.text });
      continue;
    }

    if (part?.text !== undefined) {
      textParts.push({ type: "text", text: part.text });
    }

    if (part?.inlineData) {
      textParts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        }
      });
    }

    if (part?.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }

    if (part?.functionResponse) {
      toolResults.push({
        role: "tool",
        tool_call_id: part.functionResponse.id || part.functionResponse.name,
        content: JSON.stringify(part.functionResponse.response?.result || part.functionResponse.response || {})
      });
    }
  }

  if (toolResults.length > 0) return toolResults;

  if (toolCalls.length > 0) {
    const message = { role: "assistant", tool_calls: toolCalls };
    if (textParts.length > 0) {
      message.content = textParts.length === 1 && textParts[0].type === "text" ? textParts[0].text : textParts;
    }
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    return message;
  }

  if (textParts.length > 0 || reasoningContent) {
    const message = { role };
    if (textParts.length > 0) {
      message.content = textParts.length === 1 && textParts[0].type === "text" ? textParts[0].text : textParts;
    }
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    return message;
  }

  return null;
}

function convertAntigravityRequest(body) {
  const req = body?.request || body;
  const result = {
    model: body?.model || req?.model,
    messages: [],
    stream: true
  };

  if (req?.systemInstruction) {
    const systemText = extractText(req.systemInstruction);
    if (systemText) {
      result.messages.push({ role: "system", content: systemText });
    }
  }

  if (Array.isArray(req?.contents)) {
    for (const content of req.contents) {
      const converted = convertAntigravityContent(content);
      if (!converted) continue;
      if (Array.isArray(converted)) {
        result.messages.push(...converted);
      } else {
        result.messages.push(converted);
      }
    }
  }

  const generationConfig = req?.generationConfig;
  if (generationConfig?.temperature !== undefined) result.temperature = generationConfig.temperature;
  if (generationConfig?.topP !== undefined) result.top_p = generationConfig.topP;
  if (generationConfig?.topK !== undefined) result.top_k = generationConfig.topK;
  if (generationConfig?.maxOutputTokens !== undefined) result.max_tokens = generationConfig.maxOutputTokens;

  return result;
}

function extractRequestConfig(body) {
  if (!body || typeof body !== "object") return {};

  if (body.request?.contents && Array.isArray(body.request.contents)) {
    return convertAntigravityRequest(body);
  }

  const config = { messages: body.messages || [], model: body.model, stream: body.stream !== false };
  for (const field of OPTIONAL_REQUEST_FIELDS) {
    if (body[field] !== undefined) config[field] = body[field];
  }
  return config;
}

function buildInputOnlyRequestDetail({ detailId, provider, model, connectionId, bodyBuffer }) {
  const parsedBody = safeJsonParse(bodyBuffer.toString()) || {};

  return {
    id: detailId,
    provider,
    model: model || parsedBody.model || "unknown",
    connectionId,
    status: "input_only",
    latency: { ttft: 0, total: 0 },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(parsedBody),
    providerRequest: parsedBody,
    providerResponse: "[Token swap passthrough - provider response not captured]",
    response: {
      content: "[Output not captured in token swap mode]",
      thinking: null,
      type: "token_swap_input_only"
    }
  };
}

function createTokenSwapUsageObserver({ provider, model, connectionId, accountLabel, bodyBuffer, contentType, contentEncoding, statusCode, detailRecord, requestStartTime }) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const isSse = typeof contentType === "string" && contentType.includes("text/event-stream");
  const isEncoded = Boolean(contentEncoding);
  const requestBody = safeJsonParse(bodyBuffer.toString());
  const rawChunks = [];

  let buffer = "";
  let contentLength = 0;
  let usage = null;
  let finished = false;
  let responseContent = "";
  let thinkingContent = "";
  let contentCapped = false;
  const MAX_CAPTURE_BYTES = 512 * 1024;

  const processParsedChunk = (parsed) => {
    const extracted = extractUsage(parsed);
    if (extracted) usage = extracted;
    contentLength += extractContentLength(parsed);
    if (!contentCapped) {
      const text = extractContentText(parsed);
      responseContent += text.content;
      thinkingContent += text.thinking;
      if (responseContent.length + thinkingContent.length > MAX_CAPTURE_BYTES) {
        contentCapped = true;
      }
    }
  };

  const processSseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    const parsed = safeJsonParse(payload);
    if (parsed) processParsedChunk(parsed);
  };

  return {
    onChunk(chunk) {
      if (finished) return;

      if (isEncoded || !isSse) {
        rawChunks.push(chunk);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processSseLine(line);
      }
    },

    async onEnd() {
      if (finished) return;
      finished = true;

      if (statusCode < 200 || statusCode >= 300) return;

      if (isEncoded) {
        const decoded = decodeResponseBody(Buffer.concat(rawChunks), contentEncoding);
        if (decoded) {
          if (isSse) {
            for (const line of decoded.split("\n")) {
              processSseLine(line);
            }
          } else {
            const parsed = safeJsonParse(decoded);
            if (parsed) processParsedChunk(parsed);
          }
        }
      } else if (isSse) {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;
        if (buffer.trim()) processSseLine(buffer);
      } else if (rawChunks.length > 0) {
        const parsed = safeJsonParse(Buffer.concat(rawChunks).toString("utf-8"));
        if (parsed) {
          processParsedChunk(parsed);
        }
      }

      if (!hasValidUsage(usage) && contentLength > 0) {
        usage = estimateUsage(requestBody, contentLength);
      }

      if (!hasValidUsage(usage)) return;

      const inTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const outTokens = usage.completion_tokens || usage.output_tokens || 0;
      log(`📊 [token-swap] usage "${accountLabel}" in=${inTokens} out=${outTokens}${usage.estimated ? " estimated" : ""}`);

      try {
        await persistUsage({
          provider,
          model,
          connectionId,
          tokens: usage,
          status: `${statusCode} OK`
        });
      } catch (error) {
        err(`[token-swap] ${error.message}`);
      }

      if (!detailRecord?.id) return;

      try {
        await persistRequestDetail({
          ...detailRecord,
          status: "completed",
          tokens: usage,
          latency: {
            ttft: 0,
            total: requestStartTime ? Date.now() - requestStartTime : 0
          },
          providerResponse: "[SSE stream — content captured in response field]",
          response: {
            content: responseContent || null,
            thinking: thinkingContent || null,
            type: contentCapped ? "token_swap_capped" : "token_swap"
          }
        });
      } catch (error) {
        err(`[token-swap] ${error.message}`);
      }
    }
  };
}

module.exports = {
  buildInputOnlyRequestDetail,
  createTokenSwapUsageObserver,
  generateDetailId,
};
