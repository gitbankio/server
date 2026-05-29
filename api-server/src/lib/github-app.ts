import crypto from "crypto";

const GITHUB_APP_ID = process.env["GITHUB_APP_ID"] ?? "";
const GITHUB_APP_PEM = normalizePem(process.env["GITHUB_APP_PEM"] ?? "");

function normalizePem(raw: string): string {
  if (!raw) return "";
  let pem = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (pem.includes("\n")) return pem;
  const match = pem.match(/-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/);
  if (!match) throw new Error("Invalid PEM: could not find BEGIN/END markers");
  const type = match[1];
  const b64  = match[2].replace(/\s+/g, "");
  const body = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generateAppJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: GITHUB_APP_ID }));
  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  const signature = base64url(sign.sign(GITHUB_APP_PEM));
  return `${signing}.${signature}`;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const jwt = generateAppJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Gitbank",
      },
    }
  );
  const data = (await res.json()) as { token?: string; message?: string };
  if (!data.token) throw new Error(`Failed to get installation token: ${data.message ?? "unknown"}`);
  return data.token;
}

export async function listInstallationRepos(installationId: number): Promise<Array<{ id: number; full_name: string; private: boolean; html_url: string }>> {
  const token = await getInstallationToken(installationId);
  const res = await fetch("https://api.github.com/installation/repositories?per_page=100", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Gitbank",
    },
  });
  const data = (await res.json()) as { repositories?: Array<{ id: number; full_name: string; private: boolean; html_url: string }> };
  return data.repositories ?? [];
}
