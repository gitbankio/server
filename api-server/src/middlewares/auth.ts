import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.githubId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}
