# cc-model-switcher

Claude Code plugin + CLI for switching the active model while keeping the same provider/auth config.

## What it does

- Fetches live model IDs from current provider (`ANTHROPIC_BASE_URL` → `/models`) or `CPR_MODELS_URL`
- Enriches live IDs with bundled metadata seed plus optional local override from `CPR_MODEL_METADATA_FILE` or `~/.claude/model-switcher/proxy-model-metadata-fixed.json`
- Updates only model fields in `~/.claude/settings.json`
- Keeps provider switching and model switching separate

## Install as Claude Code plugin

```text
/plugin marketplace add mrichlaz/cc-model-switcher
/plugin install model-switcher@cc-model-switcher
```

Restart Claude Code after installing.

## Plugin commands

List live models:

```text
/model-switcher:models
```

Switch model:

```text
/model-switcher:model provider/model-id
```

## CLI

Build:

```bash
npm install
npm run build
```

Interactive model picker:

```bash
cc model
# or
cc model switch
```

List models:

```bash
CPR_MODELS_URL='https://your-proxy.example/v1/models' cc --models
```

Switch model directly:

```bash
cc model switch provider/model-id
```

## Environment

Optional live models URL override:

```bash
export CPR_MODELS_URL='https://your-proxy.example/v1/models'
```

If unset, the tool derives `/models` from current Claude `ANTHROPIC_BASE_URL`, so `cc provider switch <profile>` changes the model list automatically.

Optional metadata seed override:

```bash
export CPR_MODEL_METADATA_FILE='/path/to/proxy-model-metadata.json'
```

Bundled metadata seed:

```text
data/model-metadata-seed.json
```

Optional local override path:

```text
~/.claude/model-switcher/proxy-model-metadata-fixed.json
```

Provider switching:

```bash
cc provider
cc provider list
cc provider switch <profile>
```

Model switching uses the active provider after provider switch.

## Claude auth note

Use either `apiKeyHelper` in `~/.claude/settings.json` or `ANTHROPIC_AUTH_TOKEN` in environment, not both.
