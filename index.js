import OpenAI from "openai";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("La variable OPENAI_API_KEY est manquante.");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = new McpServer({
  name: "openai-embeddings-mcp",
  version: "1.0.0",
});

server.tool(
  "embed_text",
  "Génère un embedding OpenAI à partir d'un texte",
  {
    text: z.string().min(1).describe("Texte à vectoriser"),
    model: z
      .enum(["text-embedding-3-small", "text-embedding-3-large"])
      .optional()
      .describe("Modèle d'embedding à utiliser"),
  },
  async ({ text, model = "text-embedding-3-small" }) => {
    try {
      const result = await openai.embeddings.create({
        model,
        input: text,
        dimensions: 1536,
      });

      const embedding = result.data[0].embedding;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                model: result.model,
                dimensions: embedding.length,
                usage: result.usage,
                embedding,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Erreur embedding : ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "embed_batch",
  "Génère des embeddings OpenAI pour plusieurs textes",
  {
    texts: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("Liste de textes à vectoriser"),
    model: z
      .enum(["text-embedding-3-small", "text-embedding-3-large"])
      .optional()
      .describe("Modèle d'embedding à utiliser"),
  },
  async ({ texts, model = "text-embedding-3-small" }) => {
    try {
      const result = await openai.embeddings.create({
        model,
        input: texts,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                model: result.model,
                count: result.data.length,
                dimensions: result.data[0]?.embedding?.length ?? 0,
                usage: result.usage,
                embeddings: result.data.map((item) => item.embedding),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Erreur batch embedding : ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Serveur MCP OpenAI Embeddings démarré.");
