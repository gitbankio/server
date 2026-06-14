import session from "express-session";

export const sessionMiddleware = session({
  secret: process.env["SESSION_SECRET"] ?? "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

declare module "express-session" {
  interface SessionData {
    githubId: number;
    githubLogin: string;
    accessToken: string;
  }
}
