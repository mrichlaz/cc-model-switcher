import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCurrentModel, getModelsUrl, listAvailableModels } from "../models.js";

export function registerListModels(server: McpServer): void {
  server.registerTool(
    "list_models",
    {
      description: "List available Claude models from metadata file with active indicator",
      inputSchema: {},
    },
    async () => {
      const current = getCurrentModel();
      const models = listAvailableModels();
      const sourceUrl = getModelsUrl();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                active: current,
                sourceUrl,
                metadataFile: process.env.CPR_MODEL_METADATA_FILE || null,
                models,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
