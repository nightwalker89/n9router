import fs from "node:fs";
import path from "node:path";
import { LEGACY_FILES } from "./paths.js";
import { parseJson } from "./helpers/jsonCol.js";

function providerConnectionRow(row) {
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function providerNodeRow(row) {
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function proxyPoolRow(row) {
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readKvMap(db, scope) {
  const out = {};
  for (const row of db.all(`SELECT key, value FROM kv WHERE scope = ?`, [scope])) {
    out[row.key] = parseJson(row.value);
  }
  return out;
}

export function buildLegacyMainJsonSnapshot(db) {
  const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
  const customModels = Object.values(readKvMap(db, "customModels"));

  return {
    settings: settingsRow ? parseJson(settingsRow.data, {}) : {},
    providerConnections: db.all(`SELECT * FROM providerConnections`).map(providerConnectionRow),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map(providerNodeRow),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map(proxyPoolRow),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      machineId: row.machineId,
      isActive: row.isActive === 1 || row.isActive === true,
      createdAt: row.createdAt,
    })),
    combos: db.all(`SELECT * FROM combos`).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      models: parseJson(row.models, []),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    modelAliases: readKvMap(db, "modelAliases"),
    customModels,
    mitmAlias: readKvMap(db, "mitmAlias"),
    pricing: readKvMap(db, "pricing"),
  };
}

export function syncLegacyMainJson(db) {
  try {
    const file = LEGACY_FILES.main;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(buildLegacyMainJsonSnapshot(db), null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn(`[DB][compat] db.json sync failed: ${error.message}`);
  }
}
