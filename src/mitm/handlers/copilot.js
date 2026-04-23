const { interceptWithMappedModel } = require("./interceptWithMappedModel");

// Map Copilot endpoint → 9Router path
const URL_MAP = {
  "/chat/completions": "/v1/chat/completions",
  "/v1/messages":      "/v1/messages",
  "/responses":        "/v1/responses",
};

function resolveRouterPath(req) {
  for (const [pattern, routerPath] of Object.entries(URL_MAP)) {
    if (req.url.includes(pattern)) return routerPath;
  }
  return "/v1/chat/completions";
}

/**
 * Intercept Copilot request — replace model and forward to matching 9Router endpoint
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  return interceptWithMappedModel(req, res, bodyBuffer, mappedModel, { resolveRouterPath });
}

module.exports = { intercept };
