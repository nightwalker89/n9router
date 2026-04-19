const { fetchRouter, pipeSSE } = require("./base");

async function interceptWithMappedModel(req, res, bodyBuffer, mappedModel, options = {}) {
  const body = JSON.parse(bodyBuffer.toString());
  body.model = mappedModel;
  const debugContext = options.debugContext || null;

  const routerPath = typeof options.resolveRouterPath === "function"
    ? options.resolveRouterPath(req)
    : "/v1/chat/completions";

  debugContext?.log("router.request", {
    mode: "mapped",
    routerPath,
    mappedModel,
    routerBody: body,
  });

  const routerRes = await fetchRouter(body, routerPath, req.headers);
  await pipeSSE(routerRes, res, debugContext);
}

module.exports = { interceptWithMappedModel };
