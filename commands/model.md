---
description: Switch Claude Code model without changing provider profile (example: /model-switcher:model cx/gpt-5.4)
allowed-tools: Bash(cc:*)
---

If "$ARGUMENTS" is empty or not provided:
- Run `cc --models` to list available models.
- Show the user the available models.
- Ask the user which model they want to switch to.
- Wait for their response before proceeding.

Once you have model id (from $ARGUMENTS or user input):
- Run `cc model switch <model-id>`.

Then tell the user:
- whether the switch succeeded
- and that they should restart Claude Code or start a new session if current session cached old model state.
