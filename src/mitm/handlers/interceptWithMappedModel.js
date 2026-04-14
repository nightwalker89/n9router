const { fetchRouter, pipeSSE } = require("./base");

async function interceptWithMappedModel(req, res, bodyBuffer, mappedModel, options = {}) {
  const body = JSON.parse(bodyBuffer.toString());
  body.model = mappedModel;

  const routerPath = typeof options.resolveRouterPath === "function"
    ? options.resolveRouterPath(req)
    : "/v1/chat/completions";

  const routerRes = await fetchRouter(body, routerPath, req.headers);
  await pipeSSE(routerRes, res);
}

module.exports = { interceptWithMappedModel };
