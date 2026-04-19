const https = require("https");
const {
  readMitmModelNameOverrides,
  rewriteAvailableModelsResponse,
} = require("../modelNameOverrides");

function getTargetHost(req) {
  return (req.headers.host || "daily-cloudcode-pa.googleapis.com").split(":")[0];
}

async function handleAntigravityAvailableModels({
  req,
  res,
  bodyBuffer,
  dbFile,
  resolveTargetIP,
  debugContext = null,
  log = () => {},
  err = () => {},
}) {
  const targetHost = getTargetHost(req);
  const targetIP = await resolveTargetIP(targetHost);

  debugContext?.log("route.selected", {
    tool: "antigravity",
    mode: "model_list_rewrite",
    url: req.url,
  });

  const headers = {
    ...req.headers,
    host: targetHost,
    "accept-encoding": "identity",
  };

  return new Promise((resolve) => {
    const forwardReq = https.request({
      hostname: targetIP,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
      servername: targetHost,
      rejectUnauthorized: false,
    }, (forwardRes) => {
      const chunks = [];

      forwardRes.on("data", (chunk) => chunks.push(chunk));
      forwardRes.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        const statusCode = forwardRes.statusCode || 0;
        const overrides = readMitmModelNameOverrides({ dbFile, tool: "antigravity" });

        if (statusCode < 200 || statusCode >= 300) {
          debugContext?.log("model_list_rewrite.skipped", {
            reason: "non_success_status",
            statusCode,
          });
          res.writeHead(statusCode, forwardRes.headers);
          res.end(rawBuffer);
          debugContext?.logResponse({
            statusCode,
            headers: forwardRes.headers,
            bodyBuffer: rawBuffer,
            streamed: false,
            note: "Available models upstream response",
          });
          resolve(true);
          return;
        }

        const rewrite = rewriteAvailableModelsResponse({
          rawBuffer,
          headers: forwardRes.headers,
          overrides,
        });

        if (!rewrite.changed) {
          debugContext?.log("model_list_rewrite.skipped", {
            reason: rewrite.reason || "unchanged",
          });
          res.writeHead(statusCode, forwardRes.headers);
          res.end(rawBuffer);
          debugContext?.logResponse({
            statusCode,
            headers: forwardRes.headers,
            bodyBuffer: rawBuffer,
            streamed: false,
            note: "Available models passthrough response",
          });
          resolve(true);
          return;
        }

        log(`✏️ [antigravity] rewrote model list labels: ${rewrite.changedModelIds.join(", ")}`);
        debugContext?.log("model_list_rewrite.applied", {
          changedModelIds: rewrite.changedModelIds,
          count: rewrite.changedModelIds.length,
        });
        res.writeHead(statusCode, rewrite.headers);
        res.end(rewrite.bodyBuffer);
        debugContext?.logResponse({
          statusCode,
          headers: rewrite.headers,
          bodyBuffer: rewrite.bodyBuffer,
          streamed: false,
          note: "Available models rewritten response",
        });
        resolve(true);
      });
    });

    forwardReq.on("error", (error) => {
      err(`Available models passthrough error: ${error.message}`);
      debugContext?.logError("model_list_rewrite.error", error, { targetHost, url: req.url });
      if (!res.headersSent) res.writeHead(502);
      res.end("Bad Gateway");
      resolve(true);
    });

    if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
    forwardReq.end();
  });
}

module.exports = { handleAntigravityAvailableModels };
