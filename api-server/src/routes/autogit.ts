import { Router } from "express";
import { db, scaffoldsTable, installationsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getInstallationToken } from "../lib/github-app";

const router = Router();

const DEPLOY_WORKFLOW = `name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install --legacy-peer-deps
      - run: npm run build
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist
      - uses: actions/deploy-pages@v4
        id: deployment`;

const FIXED_PACKAGE_JSON = JSON.stringify({
  name: "autogit-app",
  private: true,
  version: "0.0.0",
  type: "module",
  scripts: {
    dev: "vite",
    build: "tsc --noEmit && vite build",
    preview: "vite preview"
  },
  dependencies: {
    react: "^18.3.1",
    "react-dom": "^18.3.1"
  },
  devDependencies: {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    autoprefixer: "^10.4.20",
    postcss: "^8.4.47",
    tailwindcss: "^3.4.13",
    typescript: "^5.5.3",
    vite: "^5.4.8"
  }
}, null, 2);

const FIXED_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    useDefineForClassFields: true,
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    skipLibCheck: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: "force",
    noEmit: true,
    jsx: "react-jsx",
    strict: false,
    noUnusedLocals: false,
    noUnusedParameters: false
  },
  include: ["src"]
}, null, 2);

const FIXED_POSTCSS = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`;

const FIXED_TAILWIND = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};`;

const SYSTEM_PROMPT = `You are AutoGit, an expert full-stack developer. Generate a complete, working, visually polished web application.

Return ONLY valid JSON with no markdown, no code fences, no explanation. Format:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "vite.config.ts", "content": "..." },
    { "path": "src/main.tsx", "content": "..." },
    { "path": "src/App.tsx", "content": "..." },
    { "path": "src/index.css", "content": "..." }
  ]
}

Rules:
- Use React 18 + Vite + TypeScript + Tailwind CSS v3
- Do NOT include package.json, tsconfig.json, postcss.config.js, tailwind.config.js, or .github/workflows/deploy.yml — these are provided automatically
- vite.config.ts must use @vitejs/plugin-react and set base: "./" for GitHub Pages compatibility
- index.css must contain exactly: @tailwind base; @tailwind components; @tailwind utilities;
- Use only Tailwind utility classes — no custom CSS, no CSS modules, no styled-components
- All components must be in src/App.tsx (single file app)
- Do NOT use any backend, APIs, or database — frontend only
- Make it visually polished with thoughtful layout, typography, spacing, and color
- Do NOT import any third-party libraries beyond react and react-dom`;

function buildMessages(prompt: string, existingFiles?: Array<{ path: string; content: string }>, instruction?: string) {
  if (existingFiles && instruction) {
    const filesStr = existingFiles.map(f => `// ${f.path}\n${f.content}`).join("\n\n---\n\n");
    return [
      { role: "user" as const, content: `${SYSTEM_PROMPT}\n\nExisting code:\n${filesStr}\n\nImprovement request: ${instruction}\n\nReturn the complete updated files JSON.` }
    ];
  }
  return [
    { role: "user" as const, content: `${SYSTEM_PROMPT}\n\nBuild this app: ${prompt}` }
  ];
}

async function callOpenAICompat(baseUrl: string, apiKey: string, model: string, messages: Array<{ role: string; content: string }>, res: import("express").Response) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: 8192, stream: false }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(apiKey: string, model: string, messages: Array<{ role: string; content: string }>, _res: import("express").Response) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, messages, max_tokens: 8192 }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  return data.content.find(b => b.type === "text")?.text ?? "";
}

async function callGemini(apiKey: string, model: string, messages: Array<{ role: string; content: string }>, _res: import("express").Response) {
  const parts = messages.map(m => ({ text: m.content }));
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 8192 } }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  return data.candidates[0]?.content?.parts[0]?.text ?? "";
}

async function callAI(provider: string, apiKey: string, model: string, messages: Array<{ role: string; content: string }>, res: import("express").Response): Promise<string> {
  switch (provider) {
    case "openai": return callOpenAICompat("https://api.openai.com/v1", apiKey, model, messages, res);
    case "deepseek": return callOpenAICompat("https://api.deepseek.com/v1", apiKey, model, messages, res);
    case "groq": return callOpenAICompat("https://api.groq.com/openai/v1", apiKey, model, messages, res);
    case "anthropic": return callAnthropic(apiKey, model, messages, res);
    case "google": return callGemini(apiKey, model, messages, res);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function parseFiles(raw: string): Array<{ path: string; content: string }> {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON found in AI response");
  const jsonStr = trimmed.slice(jsonStart, jsonEnd + 1);
  const parsed = JSON.parse(jsonStr) as { files: Array<{ path: string; content: string }> };
  if (!Array.isArray(parsed.files)) throw new Error("Invalid files structure");
  // Inject all fixed infra files — override whatever the AI generated
  const INFRA_PATHS = new Set([
    ".github/workflows/deploy.yml",
    "package.json",
    "tsconfig.json",
    "postcss.config.js",
    "tailwind.config.js",
  ]);
  const appFiles = parsed.files.filter(f => !INFRA_PATHS.has(f.path));
  appFiles.push({ path: ".github/workflows/deploy.yml", content: DEPLOY_WORKFLOW });
  appFiles.push({ path: "package.json", content: FIXED_PACKAGE_JSON });
  appFiles.push({ path: "tsconfig.json", content: FIXED_TSCONFIG });
  appFiles.push({ path: "postcss.config.js", content: FIXED_POSTCSS });
  appFiles.push({ path: "tailwind.config.js", content: FIXED_TAILWIND });
  return appFiles;
}

function sseWrite(res: import("express").Response, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.post("/autogit/generate", requireAuth, async (req, res) => {
  const { prompt, apiKey, provider, model } = req.body as { prompt: string; apiKey: string; provider: string; model: string };
  if (!prompt || !apiKey || !provider || !model) {
    res.status(400).json({ error: "prompt, apiKey, provider, model are required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sessionId = crypto.randomUUID();
  sseWrite(res, { type: "session", sessionId });

  try {
    await db.insert(scaffoldsTable).values({ id: sessionId, githubId: req.session.githubId!, prompt, files: [], status: "generating" });
    sseWrite(res, { type: "status", message: "Calling AI..." });

    const messages = buildMessages(prompt);
    const raw = await callAI(provider, apiKey, model, messages, res);

    sseWrite(res, { type: "status", message: "Parsing files..." });
    const files = parseFiles(raw);

    await db.update(scaffoldsTable).set({ files, status: "ready" }).where(eq(scaffoldsTable.id, sessionId));

    for (const file of files) {
      sseWrite(res, { type: "file", path: file.path });
    }
    sseWrite(res, { type: "done", files });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "autogit generate error");
    await db.update(scaffoldsTable).set({ status: "ready" }).where(eq(scaffoldsTable.id, sessionId)).catch(() => {});
    sseWrite(res, { type: "error", message: msg });
  }

  res.end();
});

router.post("/autogit/improve", requireAuth, async (req, res) => {
  const { sessionId, instruction, apiKey, provider, model } = req.body as { sessionId: string; instruction: string; apiKey: string; provider: string; model: string };
  if (!sessionId || !instruction || !apiKey || !provider || !model) {
    res.status(400).json({ error: "sessionId, instruction, apiKey, provider, model are required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const [session] = await db.select().from(scaffoldsTable).where(and(eq(scaffoldsTable.id, sessionId), eq(scaffoldsTable.githubId, req.session.githubId!)));
    if (!session) {
      sseWrite(res, { type: "error", message: "Session not found" });
      res.end();
      return;
    }

    sseWrite(res, { type: "status", message: "Improving with AI..." });
    const messages = buildMessages(session.prompt, session.files as Array<{ path: string; content: string }>, instruction);
    const raw = await callAI(provider, apiKey, model, messages, res);

    sseWrite(res, { type: "status", message: "Parsing updated files..." });
    const files = parseFiles(raw);

    await db.update(scaffoldsTable).set({ files, status: "ready" }).where(eq(scaffoldsTable.id, sessionId));

    for (const file of files) {
      sseWrite(res, { type: "file", path: file.path });
    }
    sseWrite(res, { type: "done", files });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "autogit improve error");
    sseWrite(res, { type: "error", message: msg });
  }

  res.end();
});

router.get("/autogit/sessions", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(scaffoldsTable).where(eq(scaffoldsTable.githubId, req.session.githubId!)).orderBy(desc(scaffoldsTable.createdAt)).limit(20);
    const sessions = rows.map(r => ({
      id: r.id,
      prompt: r.prompt,
      status: r.status,
      files: (r.files as Array<{ path: string; content: string }>) ?? [],
      repoUrl: r.repoUrl ?? null,
      pagesUrl: r.pagesUrl ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json(sessions);
  } catch (err) {
    req.log.error({ err }, "autogit list sessions error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/autogit/sessions/:sessionId", requireAuth, async (req, res) => {
  try {
    const sid = String(req.params["sessionId"] ?? "");
    const [row] = await db.select().from(scaffoldsTable).where(and(eq(scaffoldsTable.id, sid), eq(scaffoldsTable.githubId, req.session.githubId!)));
    if (!row) { res.status(404).json({ error: "Session not found" }); return; }
    res.json({
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      files: (row.files as Array<{ path: string; content: string }>) ?? [],
      repoUrl: row.repoUrl ?? null,
      pagesUrl: row.pagesUrl ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "autogit get session error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/autogit/deploy", requireAuth, async (req, res) => {
  const { sessionId, repoName, enablePages } = req.body as { sessionId: string; repoName: string; enablePages?: boolean };
  if (!sessionId || !repoName) { res.status(400).json({ error: "sessionId and repoName are required" }); return; }

  try {
    const [session] = await db.select().from(scaffoldsTable).where(and(eq(scaffoldsTable.id, sessionId), eq(scaffoldsTable.githubId, req.session.githubId!)));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const ownerLogin = req.session.githubLogin!;

    // Find the installation that has access to this repo
    const installations = await db.select().from(installationsTable).where(eq(installationsTable.githubId, req.session.githubId!));
    if (installations.length === 0) {
      res.status(400).json({ error: "Gitbank bot is not installed on your GitHub account. Please install it first via the Repos page." });
      return;
    }

    // Try each installation until we find one with access to the target repo
    let botToken: string | null = null;
    let repoHtmlUrl = `https://github.com/${ownerLogin}/${repoName}`;
    for (const inst of installations) {
      try {
        const token = await getInstallationToken(inst.installationId);
        const checkResp = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
        });
        if (checkResp.ok) {
          const data = (await checkResp.json()) as { html_url: string };
          repoHtmlUrl = data.html_url;
          botToken = token;
          break;
        }
      } catch { continue; }
    }
    if (!botToken) {
      res.status(400).json({ error: `Repo "${repoName}" not found or gitbank bot has no access to it. Make sure the bot is installed on this repo.` });
      return;
    }

    const files = (session.files as Array<{ path: string; content: string }>) ?? [];
    for (const file of files) {
      // Fetch current SHA to handle existing files (update vs create)
      let sha: string | undefined;
      const getResp = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}/contents/${file.path}`, {
        headers: { Authorization: `Bearer ${botToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
      });
      if (getResp.ok) {
        const existing = (await getResp.json()) as { sha?: string };
        sha = existing.sha;
      }
      const content = Buffer.from(file.content).toString("base64");
      await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}/contents/${file.path}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${botToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
        body: JSON.stringify({ message: `Add ${file.path} via AutoGit`, content, ...(sha ? { sha } : {}) }),
      });
    }

    // Enable GitHub Pages — try bot token first, fall back to user OAuth token
    // build_type "workflow" = Actions-based deployment (matches our deploy.yml using actions/deploy-pages)
    const pagesUrl = `https://${ownerLogin}.github.io/${repoName}`;
    if (enablePages !== false) {
      const pagesTokens = [botToken, req.session.accessToken].filter(Boolean) as string[];
      for (const tok of pagesTokens) {
        const pagesResp = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}/pages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
          body: JSON.stringify({ build_type: "workflow" }),
        });
        if (pagesResp.ok || pagesResp.status === 409) break; // 409 = already enabled
      }
    }

    await db.update(scaffoldsTable).set({ status: "deployed", repoUrl: repoHtmlUrl, pagesUrl }).where(eq(scaffoldsTable.id, sessionId));
    res.json({ repoUrl: repoHtmlUrl, pagesUrl });
  } catch (err) {
    req.log.error({ err }, "autogit deploy error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/autogit/repos", requireAuth, async (req, res) => {
  try {
    const installations = await db.select().from(installationsTable).where(eq(installationsTable.githubId, req.session.githubId!));
    if (installations.length === 0) { res.json([]); return; }
    const result: Array<{ name: string; url: string; private: boolean; installationId: number }> = [];
    for (const inst of installations) {
      try {
        const token = await getInstallationToken(inst.installationId);
        const resp = await fetch("https://api.github.com/installation/repositories?per_page=100", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as { repositories?: Array<{ name: string; html_url: string; private: boolean }> };
        for (const r of data.repositories ?? []) {
          result.push({ name: r.name, url: r.html_url, private: r.private, installationId: inst.installationId });
        }
      } catch { continue; }
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "autogit repos error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/autogit/push", requireAuth, async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  if (!sessionId) { res.status(400).json({ error: "sessionId is required" }); return; }

  try {
    const [session] = await db.select().from(scaffoldsTable).where(and(eq(scaffoldsTable.id, sessionId), eq(scaffoldsTable.githubId, req.session.githubId!)));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    if (!session.repoUrl) { res.status(400).json({ error: "Session not deployed yet" }); return; }

    const userToken = req.session.accessToken;
    if (!userToken) {
      res.status(401).json({ error: "GitHub token expired. Please log out and log in again to grant repo access." });
      return;
    }
    const ownerLogin = req.session.githubLogin!;

    // Parse repo name from repoUrl (https://github.com/owner/repoName)
    const repoName = session.repoUrl.split("/").pop();
    if (!repoName) { res.status(400).json({ error: "Could not parse repo name" }); return; }

    const files = (session.files as Array<{ path: string; content: string }>) ?? [];
    let pushed = 0;

    for (const file of files) {
      // Fetch current SHA (needed to update existing files)
      let sha: string | undefined;
      const getResp = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}/contents/${file.path}`, {
        headers: { Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
      });
      if (getResp.ok) {
        const existing = (await getResp.json()) as { sha?: string };
        sha = existing.sha;
      }

      const content = Buffer.from(file.content).toString("base64");
      const putResp = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}/contents/${file.path}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Gitbank" },
        body: JSON.stringify({ message: `Update ${file.path} via AutoGit`, content, ...(sha ? { sha } : {}) }),
      });
      if (putResp.ok) pushed++;
    }

    res.json({ pushed, total: files.length, repoUrl: session.repoUrl });
  } catch (err) {
    req.log.error({ err }, "autogit push error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
