# MCP Server: ComfyUI Selfie

This is a simple server to generate images using a ComfyUI workflow via MCP.

- On start, you give it a ComfyUI endpoint and workflow.
- The MCP Client passes in a positive prompt.
- The server generates an image using the ComfyUI workflow and returns the image URL.