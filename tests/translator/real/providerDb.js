import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function readActiveProviders(providerFilter = []) {
  try {
    const dbPath = process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "db.json")
      : path.join(os.homedir(), ".n9router", "db.json");
    const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    let providers = [...new Set(
      (data.providerConnections || [])
        .filter((connection) => connection?.isActive !== false)
        .map((connection) => connection?.provider)
        .filter(Boolean),
    )].sort();
    if (providerFilter.length) {
      providers = providers.filter((provider) => providerFilter.includes(provider));
    }
    return providers;
  } catch {
    return [];
  }
}
