import { Router, Request, Response } from "express";
import { defaultAuditLogger } from "./logger.js";
import { AuditQueryFilters } from "../types/audit.js";
import { AuthContext } from "../types/index.js";

export function createAuditApiRouter(
  authenticateFn: (req: Request) => AuthContext | null
): Router {
  const router = Router();
  const storage = defaultAuditLogger.getStorage();

  // Authentication & Authorization Middleware for Audit API
  router.use((req: Request, res: Response, next) => {
    const authContext = authenticateFn(req);
    if (!authContext) {
      res.status(401).json({ error: "unauthorized", message: "Missing or invalid token" });
      return;
    }

    // Only 'admin' role or authorized auditor can access audit logs
    const isAuthorized =
      authContext.roles.includes("admin") ||
      authContext.roles.includes("auditor") ||
      authContext.roles.includes("security_admin");

    if (!isAuthorized) {
      res.status(403).json({
        error: "forbidden",
        message: "Access to audit logs requires 'admin' or 'auditor' role",
      });
      return;
    }

    (req as any).authContext = authContext;
    next();
  });

  /**
   * GET /api/v1/audit/logs
   * Query filtered transaction audit logs
   */
  router.get("/logs", async (req: Request, res: Response) => {
    try {
      const filters: AuditQueryFilters = {
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 100,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
        start_time: req.query.start_time as string,
        end_time: req.query.end_time as string,
        client_id: req.query.client_id as string,
        upstream_id: req.query.upstream_id as string,
        tool_name: req.query.tool_name as string,
        table: req.query.table as string,
        action_type: req.query.action_type as any,
        event_type: req.query.event_type as any,
        decision: req.query.decision as any,
      };

      if (req.query.is_consistent !== undefined) {
        filters.is_consistent = req.query.is_consistent === "true";
      }

      const result = await storage.query(filters);
      res.json({
        total: result.total,
        limit: filters.limit,
        offset: filters.offset,
        logs: result.logs,
      });
    } catch (err: any) {
      console.error("[Audit API] Error querying logs:", err);
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  });

  /**
   * GET /api/v1/audit/summary
   * High-level security metrics and anomaly breakdown
   */
  router.get("/summary", async (_req: Request, res: Response) => {
    try {
      const summary = await storage.getSummary();
      res.json(summary);
    } catch (err: any) {
      console.error("[Audit API] Error generating summary:", err);
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  });

  return router;
}
