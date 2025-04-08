import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ComfyApi,
  PromptBuilder,
  CallWrapper,
} from "@saintno/comfyui-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import 'dotenv/config';

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: {[sessionId: string]: SSEServerTransport} = {};

const envSchema = z.object({
  COMFYUI_URL: z.string().url(),
  WORKFLOW_FILE_PATH: z.string().default("workflow.json"),
  POSITIVE_PROMPT_NODE_ID: z.string(),
  POSITIVE_PROMPT_INPUT_NAME: z.string(),
  OUTPUT_NODE_ID: z.string(),
  SEED_NODE_ID: z.string(),
  SEED_INPUT_NAME: z.string(),
  PORT: z.number().default(8000),
});

const env = envSchema.parse(process.env);

// Helper to get the directory name in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Main Server Logic ---

async function main() {
  // Create an MCP server
  const server = new McpServer({
    name: "ComfyUI Selfie",
    version: "1.0.0",
    description: "Generates images of the assistant",
  });

  // Load the ComfyUI workflow from the JSON file
  let workflowJson: any;
  try {
    const workflowPath = path.resolve(__dirname, env.WORKFLOW_FILE_PATH);
    console.log(`Attempting to load workflow from: ${workflowPath}`);
    const workflowData = await fs.readFile(workflowPath, "utf-8");
    workflowJson = JSON.parse(workflowData);
    console.log("Workflow loaded successfully.");
  } catch (error) {
    console.error(
      `FATAL: Could not load workflow file from ${env.WORKFLOW_FILE_PATH}.`,
      error
    );
    process.exit(1); // Exit if workflow can't be loaded
  }

  // Define the image generation tool
  server.tool(
    "generateSelfie",
    // Input schema: requires a 'prompt' string
    {
      prompt: z
        .string()
        .describe("A partial positive text prompt for the assistant selfie generation. Write a comma-separated list of short, simple words. You can say the same thing in multiple ways to add emphasis."),
    },
    // Async handler function for the tool
    async ({ prompt }, { sessionId }) => {
      console.log(`Received image generation request with prompt: "${prompt}"`);
      try {
        // Initialize ComfyUI API client for each request (or manage connection pool if needed)
        const api = new ComfyApi(env.COMFYUI_URL);
        await api.init(); // Initialize connection and fetch necessary info
        console.log(`ComfyUI API initialized for ${env.COMFYUI_URL}`);

        // Prepare the workflow using PromptBuilder
        const promptBuilder = new PromptBuilder(
          // Pass the loaded workflow JSON
          workflowJson,
          // Define conceptual input keys for easier mapping
          ["positive_prompt", "seed"],
          // Define conceptual output key(s)
          ["generated_image"]
        )
          // Map conceptual keys to actual node IDs and input names
          .setInputNode(
            "positive_prompt",
            `${env.POSITIVE_PROMPT_NODE_ID}.inputs.${env.POSITIVE_PROMPT_INPUT_NAME}`
          )
          .setInputNode(
            "seed",
            `${env.SEED_NODE_ID}.inputs.${env.SEED_INPUT_NAME}`
          )
          // Map the conceptual output key to the node ID that produces the final image data
          .setOutputNode("generated_image", env.OUTPUT_NODE_ID)
          // Set the input values
          .input("positive_prompt", prompt)
          .input("seed", Math.floor(Math.random() * 1_000_000));

        console.log("Workflow prepared with inputs. Starting generation...");
        if (sessionId) {
          transports[sessionId]?.send({
            jsonrpc: "2.0",
            method: "progress",
            params: { progress: "0%" }
          });
        }

        // Execute the workflow and wait for the result using a Promise
        const imageUrl = await new Promise<string>((resolve, reject) => {
          new CallWrapper(api, promptBuilder)
            .onFinished((data) => {
              try {
                // Extract image info from the output node's data
                // ComfyUI typically returns an array of images even for single outputs
                const outputData = data.generated_image;
                if (
                  !outputData ||
                  !outputData.images ||
                  outputData.images.length === 0
                ) {
                  console.error(
                    "Output data format unexpected or missing images:",
                    outputData
                  );
                  return reject(
                    new Error(
                      "Generated image data not found in ComfyUI response."
                    )
                  );
                }
                const imageInfo = outputData.images[0]; // Get the first image info
                const url = api.getPathImage(imageInfo); // Construct the full URL
                console.log(`Image generated successfully: ${url}`);
                resolve(url);
              } catch (err) {
                console.error("Error processing finished data:", err);
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            })
            .onFailed((err, promptId) => {
              console.error(
                `ComfyUI job failed (Prompt ID: ${promptId}):`,
                err
              );
              reject(err);
            })
            .onStart(() => {
              if (sessionId) {
                transports[sessionId]?.send({
                  jsonrpc: "2.0",
                  method: "progress",
                  params: { progress: "0%" }
                });
              }
            })
            .onPending(() => {
              if (sessionId) {
                transports[sessionId]?.send({
                  jsonrpc: "2.0",
                  method: "progress",
                  params: { progress: "0%" }
                });
              }
            })
            .onProgress((info, promptId) => {
              console.log(
                `Progress (Prompt ID: ${promptId}): Node ${info.node} - ${info.value}/${info.max}`
              );

              if (sessionId) {
                transports[sessionId]?.send({
                  jsonrpc: "2.0",
                  method: "progress",
                  params: { progress: `${(info.value / info.max) * 100}%` }
                });
              }
            })
            .run(); // Start the execution
        });

        // Return the image URL in the correct MCP format
        return {
          content: [{ type: "text", text: imageUrl }],
        };
      } catch (error: unknown) {
        console.error("Error during image generation:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // Return an error in the MCP format
        return {
          content: [
            { type: "text", text: `Error generating image: ${errorMessage}` },
          ],
          isError: true,
        };
      }
    }
  );

  app.get("/sse", async (_: Request, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on("close", () => {
      delete transports[transport.sessionId];
    });
    await server.connect(transport);
  });
  
  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query["sessionId"] as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });
  
  app.listen(env.PORT);
}

main().catch((error) => {
  console.error("Unhandled error in main function:", error);
  process.exit(1);
});
