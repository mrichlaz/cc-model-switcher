import { Command } from "commander";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { listProfiles, detectActiveProfile, switchToProvider } from "./profiles.js";
import { runInteractiveMenu } from "./interactive.js";
import { mcpServer } from "./mcp.js";
import {
  getCurrentModel,
  getModelsUrl,
  listAvailableModels,
  setupClaudeRouteConfig,
  switchToModel,
  getModelSwitcherConfigPath,
} from "./models.js";
import {
  isMacOS,
  saveCredentialForProfile,
  restoreCredentialForProfile,
  listSavedCredentials,
} from "./credentials.js";

/**
 * Display list of installed providers
 */
function showProviderList(): void {
  const profiles = listProfiles();

  console.log(chalk.bold("Installed providers:"));

  if (!profiles || profiles.length === 0) {
    console.log(chalk.dim("  No providers installed. Run claude-provider to add one."));
    return;
  }

  const active = detectActiveProfile(profiles);

  for (const profile of profiles) {
    const marker = profile.name === active ? chalk.green(" (active)") : "";
    console.log(` - ${profile.name}${marker}`);
  }
}

/**
 * Direct switch to a provider by name
 */
function directSwitch(name: string): void {
  const profiles = listProfiles();
  const exists = profiles.some((p) => p.name.toLowerCase() === name.toLowerCase());

  if (!exists) {
    console.error(chalk.red(`Provider not installed: ${name}`));
    console.error(chalk.dim('Tip: run "claude-provider" or "cpr" to add providers interactively.'));
    process.exit(1);
  }

  // Find exact case-insensitive match
  const profile = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!profile) {
    console.error(chalk.red(`Provider not found: ${name}`));
    process.exit(1);
  }

  switchToProvider(profile.name);
  console.log(`✅ Switched to ${chalk.cyan(profile.name)}. Run "claude" then /status.`);

  // Opt-in: automatically swap the keychain OAuth credential to match the
  // newly activated profile. Enables seamless switching between profiles
  // that share an ANTHROPIC_BASE_URL (e.g. multiple Anthropic plans).
  if (isMacOS() && isCredentialAutoSwapEnabled()) {
    const result = restoreCredentialForProfile(profile.name);
    if (result.restored) {
      console.log(chalk.dim(`   (keychain credential restored from ${result.path})`));
    } else if (result.reason && result.reason !== "no saved credential for profile") {
      console.warn(chalk.yellow(`   (credential restore skipped: ${result.reason})`));
    }
  }
}

function isCredentialAutoSwapEnabled(): boolean {
  const value = process.env.CPR_SWAP_CREDENTIALS;
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function showModelList(): void {
  const models = listAvailableModels();
  const current = getCurrentModel();
  const sourceUrl = getModelsUrl();

  console.log(chalk.bold(`Available models from ${sourceUrl}:`));

  if (!models.length) {
    console.log(chalk.dim("  No models found."));
    return;
  }

  for (const model of models) {
    const marker = model.id === current ? chalk.green(" (active)") : "";
    const extras = [
      model.contextWindow ? `${model.contextWindow} ctx` : null,
      model.input?.includes("image") ? "vision" : null,
      model.reasoning === false ? "no-reasoning" : null,
    ].filter(Boolean);
    const extraText = extras.length ? chalk.dim(` [${extras.join(", ")}]`) : "";
    console.log(` - ${model.id}${marker}${extraText}`);
  }
}

function directModelSwitch(name: string): void {
  const selected = switchToModel(name);
  console.log(`✅ Switched Claude model to ${chalk.cyan(selected)}. Restart Claude Code or start new session if needed.`);
}

async function setupInteractive(): Promise<void> {
  p.intro("cc model switcher setup");

  const baseUrl = await p.text({
    message: "Anthropic-compatible base URL",
    placeholder: "https://your-proxy.example/v1",
    validate: (v) => (!v ? "Base URL required" : undefined),
  });
  if (p.isCancel(baseUrl)) return p.cancel("Cancelled");

  let derivedModelsUrl = `${String(baseUrl).replace(/\/$/, "")}/models`;
  let fetchedModels = [] as ReturnType<typeof listAvailableModels>;

  const apiKey = await p.password({
    message: "API key",
    mask: "•",
    validate: (v) => (!v ? "API key required" : undefined),
  });
  if (p.isCancel(apiKey)) return p.cancel("Cancelled");

  try {
    fetchedModels = listAvailableModels({
      apiKeyHelper: `bash -c 'echo ${String(apiKey).replace(/'/g, "'\\''")}'`,
      env: { ANTHROPIC_BASE_URL: String(baseUrl).trim() },
    });
  } catch (error) {
    p.note(
      `Could not fetch models from ${derivedModelsUrl}\n${error instanceof Error ? error.message : String(error)}`,
      "Models URL needed"
    );

    const manualModelsUrl = await p.text({
      message: "Models URL",
      placeholder: "https://your-proxy.example/v1/models",
      initialValue: String(baseUrl).includes("/claude")
        ? `${String(baseUrl).replace(/\/$/, "")}/v1/models`
        : derivedModelsUrl,
      validate: (v) => (!v ? "Models URL required" : undefined),
    });
    if (p.isCancel(manualModelsUrl)) return p.cancel("Cancelled");

    derivedModelsUrl = String(manualModelsUrl).trim();
    process.env.CPR_MODELS_URL = derivedModelsUrl;
    try {
      fetchedModels = listAvailableModels({
        apiKeyHelper: `bash -c 'echo ${String(apiKey).replace(/'/g, "'\\''")}'`,
        env: { ANTHROPIC_BASE_URL: String(baseUrl).trim() },
      });
    } catch (retryError) {
      p.cancel(
        `Could not fetch models from ${derivedModelsUrl}\n${retryError instanceof Error ? retryError.message : String(retryError)}`
      );
      return;
    }
  }

  const firstModel = fetchedModels[0]?.id;

  if (!firstModel) {
    p.cancel(`No models returned from ${derivedModelsUrl}`);
    return;
  }

  const defaultModel = await p.text({
    message: "Default model (leave empty to use first fetched model)",
    placeholder: firstModel,
    initialValue: "",
  });
  if (p.isCancel(defaultModel)) return p.cancel("Cancelled");

  setupClaudeRouteConfig({
    apiKey: String(apiKey),
    baseUrl: String(baseUrl).trim(),
    modelsUrl: derivedModelsUrl,
    metadataFile: undefined,
    defaultModel: String(defaultModel).trim() || firstModel,
  });

  const envConflicts = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"].filter(
    (key) => process.env[key]
  );

  p.note(
    `Claude settings updated: ~/.claude/settings.json\n` +
      `Model switcher config: ${getModelSwitcherConfigPath()}\n` +
      (envConflicts.length
        ? `\nWarning: shell environment still has ${envConflicts.join(", ")}. Unset these if using apiKeyHelper.`
        : ""),
    "Setup complete"
  );
  p.outro("Restart Claude Code after setup.");
}

async function interactiveModelSwitch(): Promise<void> {
  const models = listAvailableModels();
  const current = getCurrentModel();

  if (!models.length) {
    console.log(chalk.dim("No models found."));
    return;
  }

  const groupedOptions = models.map((model) => {
    const hints = [
      model.id === current ? "active" : null,
      model.contextWindow ? `${model.contextWindow} ctx` : null,
      model.input?.includes("image") ? "vision" : null,
      model.reasoning === false ? "no-reasoning" : null,
    ].filter(Boolean).join(" · ");

    return {
      value: model.id,
      label: model.id,
      hint: hints || undefined,
    };
  });

  const selected = await p.select({
    message: "Select Claude model",
    options: groupedOptions,
    initialValue: current && models.some((model) => model.id === current) ? current : undefined,
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    return;
  }

  const switched = switchToModel(String(selected));
  p.outro(`✅ Switched Claude model to ${chalk.cyan(switched)}. Restart Claude Code or start a new session if needed.`);
}

/**
 * Handle `cpr credential <action> [profile]` subcommand.
 */
function handleCredentialCommand(action: string, profile?: string): void {
  if (!isMacOS()) {
    console.error(chalk.red("credential commands are only supported on macOS"));
    process.exit(1);
  }

  switch (action) {
    case "save": {
      if (!profile) {
        console.error(chalk.red("Usage: cpr credential save <profile>"));
        process.exit(1);
      }
      const result = saveCredentialForProfile(profile);
      if (result.saved) {
        console.log(`✅ Saved credential for ${chalk.cyan(profile)} → ${result.path}`);
      } else {
        console.error(chalk.red(`Failed: ${result.reason}`));
        process.exit(1);
      }
      return;
    }
    case "restore": {
      if (!profile) {
        console.error(chalk.red("Usage: cpr credential restore <profile>"));
        process.exit(1);
      }
      const result = restoreCredentialForProfile(profile);
      if (result.restored) {
        console.log(`✅ Restored credential for ${chalk.cyan(profile)} from ${result.path}`);
      } else {
        console.error(chalk.red(`Failed: ${result.reason}`));
        process.exit(1);
      }
      return;
    }
    case "list": {
      const saved = listSavedCredentials();
      if (saved.length === 0) {
        console.log(chalk.dim("No saved credentials. Run `cpr credential save <profile>`."));
        return;
      }
      console.log(chalk.bold("Saved credentials:"));
      for (const name of saved) {
        console.log(` - ${name}`);
      }
      return;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.error(chalk.dim("Available: save, restore, list"));
      process.exit(1);
  }
}

/**
 * Create and configure the CLI program
 */
export function createProgram(): Command {
  return new Command()
    .name("claude-provider")
    .description("CLI tool to switch Claude Code models")
    .version("0.0.6")
    .argument(
      "[provider]",
      'command: setup, model, provider, credential, or a provider profile name'
    )
    .argument("[action]", 'subcommand action (for "credential" or "model")')
    .argument("[profile]", 'profile name / model id depending on subcommand')
    .option("-l, --list", "list installed providers")
    .option("--models", "list available models from metadata file");
}

/**
 * Run the CLI application
 */
export async function runCli(): Promise<void> {
  const program = createProgram();
  program.parse(process.argv);

  const opts = program.opts<{ list?: boolean; models?: boolean }>();
  const provider = program.args[0];

  if (opts.list) {
    showProviderList();
    return;
  }

  if (opts.models) {
    showModelList();
    return;
  }

  if (!provider) {
    await interactiveModelSwitch();
    return;
  }

  if (provider === "setup") {
    await setupInteractive();
    return;
  }

  if (provider == "mcp") {
    return mcpServer();
  }

  if (provider === "credential") {
    const action = program.args[1];
    const credProfile = program.args[2];
    if (!action) {
      console.error(chalk.red("Usage: cpr credential <save|restore|list> [profile]"));
      process.exit(1);
    }
    handleCredentialCommand(action, credProfile);
    return;
  }

  if (provider === "model") {
    const action = program.args[1];
    const modelId = program.args[2];

    if (!action) {
      await interactiveModelSwitch();
      return;
    }

    if (action === "list") {
      showModelList();
      return;
    }

    if (action === "switch") {
      if (!modelId) {
        await interactiveModelSwitch();
        return;
      }
      directModelSwitch(modelId);
      return;
    }

    console.error(chalk.red(`Unknown model action: ${action}`));
    console.error(chalk.dim("Available: list, switch"));
    process.exit(1);
  }

  if (provider === "provider") {
    const action = program.args[1];
    const profile = program.args[2];

    if (!action) {
      await runInteractiveMenu();
      return;
    }

    if (action === "list") {
      showProviderList();
      return;
    }

    if (action === "switch") {
      if (!profile) {
        console.error(chalk.red("Usage: cc provider switch <profile>"));
        process.exit(1);
      }
      directSwitch(profile);
      return;
    }

    console.error(chalk.red(`Unknown provider action: ${action}`));
    console.error(chalk.dim("Available: list, switch"));
    process.exit(1);
  }

  directSwitch(provider);
}

runCli().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
