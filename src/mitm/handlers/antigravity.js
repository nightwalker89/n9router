const { interceptWithMappedModel } = require("./interceptWithMappedModel");

/**
 * Intercept Antigravity request — forward Gemini body as-is to /v1/chat/completions.
 * Router auto-detects format via body.userAgent==="antigravity" + body.request.contents,
 * runs antigravity→openai→provider→openai→antigravity translators internally.
 */
async function intercept(req, res, bodyBuffer, mappedModel, options = {}) {
  return interceptWithMappedModel(req, res, bodyBuffer, mappedModel, options);
}

module.exports = { intercept };
