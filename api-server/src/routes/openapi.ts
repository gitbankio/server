import { Router, type IRouter } from "express";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const router: IRouter = Router();

const __dir = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(__dir, "../../../lib/api-spec/openapi.yaml");

let cachedSpec: unknown = null;

function getSpec(): unknown {
  if (!cachedSpec) {
    const raw = readFileSync(specPath, "utf8");
    cachedSpec = parse(raw);
  }
  return cachedSpec;
}

router.get("/openapi.json", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(getSpec());
});

export default router;
