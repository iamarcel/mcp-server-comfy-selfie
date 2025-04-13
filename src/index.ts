import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ComfyApi, PromptBuilder, CallWrapper } from "@saintno/comfyui-sdk";
import express, { Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSEServerTransport } = {};

// Create a refined schema for S3 configuration
const s3Schema = z.object({
  S3_UPLOAD_ENABLED: z.literal("true"),
  S3_REGION: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET_NAME: z.string(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_KEY_PREFIX: z.string().default("selfie/"),
});

const envSchema = z
  .object({
    COMFYUI_URL: z.string().url(),
    WORKFLOW_FILE_PATH: z.string().default("workflow.json"),
    POSITIVE_PROMPT_NODE_ID: z.string(),
    POSITIVE_PROMPT_INPUT_NAME: z.string(),
    OUTPUT_NODE_ID: z.string(),
    SEED_NODE_ID: z.string(),
    SEED_INPUT_NAME: z.string(),
    PORT: z.number().default(8000),
  })
  .and(
    // Conditionally require S3 config values only when S3_UPLOAD_ENABLED is true
    z.discriminatedUnion("S3_UPLOAD_ENABLED", [
      s3Schema,
      z.object({
        S3_UPLOAD_ENABLED: z.literal("false"),
      }),
    ]),
  );

const env = envSchema.parse(process.env);

// Helper to get the directory name in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// S3 client setup
let s3Client: S3Client | null = null;
if (env.S3_UPLOAD_ENABLED === "true") {
  s3Client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  console.log("S3 client initialized successfully");
}

/**
 * Downloads an image from a URL and uploads it to S3
 * @param imageUrl URL of the image to download
 * @returns Public URL of the uploaded image
 */
async function uploadToS3(imageUrl: string): Promise<string> {
  if (!s3Client || env.S3_UPLOAD_ENABLED !== "true") {
    throw new Error("S3 client or configuration not available");
  }

  // Generate a unique filename with timestamp and random string
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 10);

  // Download the image using fetch
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  // Get the content type from the response headers
  const contentType = response.headers.get("content-type") || "image/png";

  // Determine file extension based on content type
  let fileExtension = ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    fileExtension = ".jpg";
  } else if (contentType.includes("webp")) {
    fileExtension = ".webp";
  } else if (contentType.includes("gif")) {
    fileExtension = ".gif";
  }

  const filename = `${env.S3_KEY_PREFIX}${timestamp}-${randomString}${fileExtension}`;

  // Get the image as an array buffer
  const imageBuffer = await response.arrayBuffer();

  // Upload to S3
  const uploadParams = {
    Bucket: env.S3_BUCKET_NAME,
    Key: filename,
    Body: Buffer.from(imageBuffer),
    ContentType: contentType,
    ACL: "public-read" as const,
  };

  await s3Client.send(new PutObjectCommand(uploadParams));

  // Return the public URL
  return `${env.S3_PUBLIC_ENDPOINT}/${filename}`;
}

// --- Main Server Logic ---

async function main() {
  // Create an MCP server
  const server = new McpServer(
    {
      name: "ComfyUI Selfie",
      version: "1.0.0",
      description: "Generates images of the assistant",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

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
      error,
    );
    process.exit(1); // Exit if workflow can't be loaded
  }

  // Define the image generation tool
  server.tool(
    "generate-selfie",
    "Generate an image of the assistant. This takes about a minute to generate and will return a URL to an image, which you should display in your response.",
    {
      prompt: z.string().describe(
        `A partial positive text prompt for the assistant selfie generation.
          Write a comma-separated list of short, simple words.
          You can say the same thing in multiple ways to add emphasis.
          Make sure you always describe all elements (expression, outfit, pose, camera angle).
          Start with important elements, but also describe details in the prompt.
          Make sure this is extensive. Emphasize keywords by surrounding them with braces.
          When describing, use simple, clear expressions and no special characters, implicit words or analogies.`,
      ),
    },
    // Async handler function for the tool
    async (
      { prompt },
      { signal, _meta, sendNotification },
    ): Promise<CallToolResult> => {
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
          ["generated_image"],
        )
          // Map conceptual keys to actual node IDs and input names
          .setInputNode(
            "positive_prompt",
            `${env.POSITIVE_PROMPT_NODE_ID}.inputs.${env.POSITIVE_PROMPT_INPUT_NAME}`,
          )
          .setInputNode(
            "seed",
            `${env.SEED_NODE_ID}.inputs.${env.SEED_INPUT_NAME}`,
          )
          // Map the conceptual output key to the node ID that produces the final image data
          .setOutputNode("generated_image", env.OUTPUT_NODE_ID)
          // Set the input values
          .input("positive_prompt", prompt)
          .input("seed", Math.floor(Math.random() * 1_000_000));

        console.log("Workflow prepared with inputs. Starting generation...");
        if (_meta?.progressToken) {
          await sendNotification({
            method: "notifications/progress",
            params: { progressToken: _meta.progressToken, progress: 0 },
          });
        }

        // Execute the workflow and wait for the result using a Promise
        const comfyImageUrl = await new Promise<string>((resolve, reject) => {
          new CallWrapper(api, promptBuilder)
            .onFinished(async (data) => {
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
                    outputData,
                  );
                  return reject(
                    new Error(
                      "Generated image data not found in ComfyUI response.",
                    ),
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
            .onFailed(async (err, promptId) => {
              console.error(
                `ComfyUI job failed (Prompt ID: ${promptId}):`,
                err,
              );
              reject(err);
            })
            .onStart(async () => {
              if (_meta?.progressToken) {
                await sendNotification({
                  method: "notifications/progress",
                  params: {
                    progress: 0,
                    progressToken: _meta.progressToken,
                  },
                });
              }
            })
            .onPending(async () => {
              if (_meta?.progressToken) {
                await sendNotification({
                  method: "notifications/progress",
                  params: {
                    progress: 0,
                    progressToken: _meta.progressToken,
                  },
                });
              }

              if (signal.aborted) {
                api.interrupt();
              }
            })
            .onProgress(async (info, promptId) => {
              console.log(
                `Progress (Prompt ID: ${promptId}): Node ${info.node} - ${info.value}/${info.max}`,
              );

              if (_meta?.progressToken) {
                await sendNotification({
                  method: "notifications/progress",
                  params: {
                    progress: info.value / info.max,
                    progressToken: _meta.progressToken,
                  },
                });
              }

              if (signal.aborted) {
                api.interrupt();
              }
            })
            .run(); // Start the execution
        });

        // If S3 upload is enabled, upload the image and return the S3 URL
        let finalImageUrl = comfyImageUrl;
        if (env.S3_UPLOAD_ENABLED && s3Client) {
          try {
            console.log("Uploading image to S3...");
            finalImageUrl = await uploadToS3(comfyImageUrl);
            console.log(`Image uploaded to S3: ${finalImageUrl}`);
          } catch (s3Error) {
            console.error(
              "Error uploading to S3, falling back to ComfyUI URL:",
              s3Error,
            );
            // Fall back to the ComfyUI URL if S3 upload fails
          }
        }

        // Return the image URL in the correct MCP format
        return {
          content: [{ type: "text", text: finalImageUrl }],
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
    },
  );

  app.get("/sse", async (_: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
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
      res.status(400).send("No transport found for sessionId");
    }
  });

  app.listen(env.PORT);
  console.log(`Server started on port ${env.PORT}`);
}

main().catch((error) => {
  console.error("Unhandled error in main function:", error);
  process.exit(1);
});
