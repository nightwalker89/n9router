const { interceptWithMappedModel } = require("./interceptWithMappedModel");

/**
 * Intercept Antigravity (Gemini) request — replace model and forward to router
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  return interceptWithMappedModel(req, res, bodyBuffer, mappedModel);
}

module.exports = { intercept };
