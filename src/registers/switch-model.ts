import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { switchToModel } from "../models.js";

export function registerSwitchModel(server: McpServer): void {
  server.registerTool(
    "switch_model",
    {
      description: "Switch Claude Code current model without changing provider/base URL/auth",
      inputSchema: {
        model: z.string().min(1).describe("Model id to activate"),
      },
    },
    async ({ model }) => {
      try {
        const selected = switchToModel(model);
        return {
          content: [
            {
              type: "text",
              text:
                `Switched Claude model to \"${selected}\" in ~/.claude/settings.json.\n` +
                `Restart Claude Code or start a new session if current session caches old model state.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
