import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNlpMcpServer } from "../lib/nlp-mcp-server";

const router = Router();

function makeTransport() {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}

router.post("/mcp/hermes", async (req, res) => {
  try {
    const server = createNlpMcpServer();
    const transport = makeTransport();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP Hermes server error" });
    }
  }
});

router.get("/mcp/hermes", async (req, res) => {
  try {
    const server = createNlpMcpServer();
    const transport = makeTransport();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP Hermes server error" });
    }
  }
});

export default router;
