import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkXOAuthCredentials } from "../lib/x-client";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/x", async (_req, res) => {
  const result = await checkXOAuthCredentials();
  res.status(result.ok ? 200 : 503).json({
    ok: result.ok,
    ...(result.reason ? { reason: result.reason } : {}),
  });
});

export default router;
