import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Settings } from "./types.js";
import { getClaudeDir, getSettingsPath, readSettings, writeSettings, createApiKeyHelper } from "./utils.js";
import { MODEL_ENV_KEYS } from "./constants.js";

export type ModelMetadata = {
  id: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  name?: string;
  owned_by?: string;
};

type RemoteModelsPayload = {
  data?: Array<Record<string, unknown>>;
};

type ModelSwitcherConfig = {
  modelsUrl?: string;
  metadataFile?: string;
};

const DEFAULT_MODEL_METADATA_FILE = path.join(getClaudeDir(), "model-switcher", "proxy-model-metadata-fixed.json");
const DEFAULT_MODELS_URL = "";
const CONFIG_FILE = path.join(getClaudeDir(), "model-switcher", "config.json");
const BUNDLED_METADATA_FILE = new URL("../data/model-metadata-seed.json", import.meta.url);

export function getModelSwitcherConfigPath(): string {
  return CONFIG_FILE;
}

export function readModelSwitcherConfig(): ModelSwitcherConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as ModelSwitcherConfig;
  } catch {
    return {};
  }
}

export function writeModelSwitcherConfig(config: ModelSwitcherConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // chmod may fail on Windows, which is fine
  }
}

export function getModelMetadataFile(): string {
  const config = readModelSwitcherConfig();
  return process.env.CPR_MODEL_METADATA_FILE || config.metadataFile || DEFAULT_MODEL_METADATA_FILE;
}

export function getModelsUrl(settings?: Settings | null): string {
  const config = readModelSwitcherConfig();
  if (process.env.CPR_MODELS_URL) return process.env.CPR_MODELS_URL;

  const current = settings ?? readSettings(getSettingsPath());
  const baseUrl = current?.env?.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl) {
    const cleanBaseUrl = baseUrl.replace(/\/$/, "");
    if (cleanBaseUrl.endsWith("/messages")) return `${cleanBaseUrl.slice(0, -9)}/models`;
    if (cleanBaseUrl.endsWith("/v1")) return `${cleanBaseUrl}/models`;
    if (cleanBaseUrl.endsWith("/anthropic")) return `${cleanBaseUrl.slice(0, -11)}/v1/models`;
    if (cleanBaseUrl.endsWith("/claude")) return `${cleanBaseUrl}/v1/models`;
    return `${cleanBaseUrl}/models`;
  }

  if (config.modelsUrl) return config.modelsUrl;

  if (!DEFAULT_MODELS_URL) {
    throw new Error("Set CPR_MODELS_URL or ANTHROPIC_BASE_URL before listing models.");
  }
  return DEFAULT_MODELS_URL;
}

function normalizeModelId(id: string): string {
  let normalized = id.includes("/") ? id.split("/").slice(1).join("/") : id;

  normalized = normalized.replace(/-review$/i, "");
  normalized = normalized.replace(/-(none|low|medium|high|xhigh|max)$/i, "");
  normalized = normalized.replace(/-(thinking|agentic|thinking-agentic)$/i, "");

  return normalized.toLowerCase();
}

function readMetadataFile(file: string | URL): ModelMetadata[] {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid model metadata file: ${String(file)}`);
  }

  return parsed.filter((row): row is ModelMetadata => !!row && typeof row.id === "string" && row.id.trim() !== "");
}

function readSeedMetadata(): ModelMetadata[] {
  const bundled = fs.existsSync(BUNDLED_METADATA_FILE) ? readMetadataFile(BUNDLED_METADATA_FILE) : [];
  const file = getModelMetadataFile();
  if (!file || !fs.existsSync(file)) return bundled;

  const local = readMetadataFile(file);
  const merged = new Map<string, ModelMetadata>();
  for (const row of bundled) merged.set(row.id, row);
  for (const row of local) merged.set(row.id, row);
  return Array.from(merged.values());
}

function extractApiKey(settings?: Settings | null): string | undefined {
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  const helper = settings?.apiKeyHelper;
  if (!helper) return undefined;

  const match = helper.match(/echo\s+['"]?([^'"]+)['"]?/);
  return match?.[1];
}

function fetchRemoteModels(url: string, apiKey?: string): ModelMetadata[] {
  try {
    const args = ["-fsSL", "--compressed", "-H", "Accept: application/json"];
    if (apiKey) args.push("-H", `Authorization: Bearer ${apiKey}`);
    args.push(url);

    const stdout = execFileSync("curl", args, {
      encoding: "utf8",
    });
    const payload = JSON.parse(stdout) as RemoteModelsPayload;
    const rows = Array.isArray(payload.data) ? payload.data : [];

    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row) => ({
        id: String(row.id ?? ""),
        name: typeof row.name === "string" ? row.name : undefined,
        owned_by: typeof row.owned_by === "string" ? row.owned_by : undefined,
        input: Array.isArray(row.input) ? row.input.filter((v): v is string => typeof v === "string") : undefined,
        contextWindow:
          typeof row.context_window === "number"
            ? row.context_window
            : typeof row.contextWindow === "number"
              ? row.contextWindow
              : typeof row.contextLength === "number"
                ? row.contextLength
                : undefined,
        maxTokens:
          typeof row.max_tokens === "number"
            ? row.max_tokens
            : typeof row.maxTokens === "number"
              ? row.maxTokens
              : typeof row.maxOutputTokens === "number"
                ? row.maxOutputTokens
                : undefined,
        reasoning: typeof row.reasoning === "boolean" ? row.reasoning : undefined,
      }))
      .filter((row) => row.id);
  } catch (error) {
    throw new Error(`Failed to fetch models from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function listAvailableModels(settings?: Settings | null): ModelMetadata[] {
  const resolvedSettings = settings ?? readSettings(getSettingsPath());
  const remote = fetchRemoteModels(getModelsUrl(resolvedSettings), extractApiKey(resolvedSettings));
  const seed = readSeedMetadata();
  const seedById = new Map(seed.map((row) => [row.id, row]));
  const seedByNormalizedId = new Map(seed.map((row) => [normalizeModelId(row.id), row]));

  return remote
    .map((row) => ({
      ...seedByNormalizedId.get(normalizeModelId(row.id)),
      ...seedById.get(row.id),
      ...row,
      id: row.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getCurrentModel(settings?: Settings | null): string | null {
  const current = settings ?? readSettings(getSettingsPath());
  if (!current) return null;

  return (
    current.model ??
    current.env?.ANTHROPIC_MODEL ??
    current.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    current.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    current.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    current.env?.ANTHROPIC_SMALL_FAST_MODEL ??
    null
  );
}

export function setupClaudeRouteConfig(options: {
  apiKey: string;
  baseUrl: string;
  modelsUrl: string;
  metadataFile?: string;
  defaultModel: string;
}): void {
  const settings = readSettings(getSettingsPath()) ?? { env: {} };
  const env = { ...settings.env };

  env.ANTHROPIC_BASE_URL = options.baseUrl;
  for (const key of MODEL_ENV_KEYS) {
    env[key] = options.defaultModel;
  }

  writeSettings(getSettingsPath(), {
    ...settings,
    apiKeyHelper: createApiKeyHelper(options.apiKey),
    model: options.defaultModel,
    env,
  });

  writeModelSwitcherConfig({
    ...(options.metadataFile ? { metadataFile: options.metadataFile } : {}),
  });
}

export function switchToModel(modelId: string): string {
  const settings = readSettings(getSettingsPath());
  if (!settings) {
    throw new Error(`Failed to read Claude settings: ${getSettingsPath()}`);
  }

  const models = listAvailableModels(settings);
  const found = models.find((model) => model.id.toLowerCase() === modelId.toLowerCase());
  if (!found) {
    throw new Error(`Model not found: ${modelId}`);
  }

  const merged: Settings = {
    ...settings,
    model: found.id,
    env: {
      ...settings.env,
    },
  };

  for (const key of MODEL_ENV_KEYS) {
    merged.env ??= {};
    merged.env[key] = found.id;
  }

  writeSettings(getSettingsPath(), merged);
  return found.id;
}
