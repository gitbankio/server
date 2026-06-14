import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "@workspace/mcp";

const router = Router();

function makeTransport() {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}

router.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = makeTransport();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP server error" });
    }
  }
});

router.get("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = makeTransport();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP server error" });
    }
  }
});

export default router;
