import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  AuditQueryFilters,
  AuditSummaryStats,
  SqlActionType,
  ZtaTransactionAuditEntry,
} from "../types/audit.js";

/**
 * Autonomous Tamper-Evident Audit Storage Engine
 * Append-only structured JSONL storage with in-memory indexing and SHA-256 hash chaining.
 * Zero external native dependencies, compatible across all Node.js versions and container runtimes.
 */
export class AuditStorage {
  private logFilePath: string;
  private cache: ZtaTransactionAuditEntry[] = [];
  private maxCacheSize: number;
  private lastHash: string = "0000000000000000000000000000000000000000000000000000000000000000";

  constructor(options?: { logDir?: string; maxCacheSize?: number }) {
    const logDir =
      options?.logDir ||
      process.env.AUDIT_LOG_DIR ||
      path.resolve(process.cwd(), "data");

    if (!fs.existsSync(logDir)) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch (err) {
        console.error(`[AuditStorage] Failed to create log directory: ${logDir}`, err);
      }
    }

    this.logFilePath = path.join(logDir, "zta_audit.jsonl");
    this.maxCacheSize = options?.maxCacheSize || 10000;

    this.loadInitialCache();
  }

  /**
   * Loads existing records into memory cache and reconstructs the latest hash chain
   */
  private loadInitialCache(): void {
    if (!fs.existsSync(this.logFilePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.logFilePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      const startIndex = Math.max(0, lines.length - this.maxCacheSize);
      for (let i = startIndex; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]) as ZtaTransactionAuditEntry;
          this.cache.push(entry);
        } catch {
          // ignore corrupted lines
        }
      }

      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        this.lastHash = crypto.createHash("sha256").update(lastLine).digest("hex");
      }
      console.log(`[AuditStorage] Loaded ${this.cache.length} audit entries from ${this.logFilePath}`);
    } catch (err) {
      console.error(`[AuditStorage] Failed reading log file: ${this.logFilePath}`, err);
    }
  }

  /**
   * Persists an audit entry with tamper-evident cryptographic chaining
   */
  public async save(entry: ZtaTransactionAuditEntry): Promise<void> {
    try {
      // Attach hash chain
      const recordWithChain = {
        ...entry,
        _chain: {
          prev_hash: this.lastHash,
        },
      };

      const line = JSON.stringify(recordWithChain);
      this.lastHash = crypto.createHash("sha256").update(line).digest("hex");

      // Append to file asynchronously
      await fs.promises.appendFile(this.logFilePath, line + "\n", "utf-8");

      // Update in-memory cache
      this.cache.unshift(entry); // newest first
      if (this.cache.length > this.maxCacheSize) {
        this.cache.pop();
      }
    } catch (err) {
      console.error("[AuditStorage] Failed to append audit record:", err);
    }
  }

  /**
   * Queries audit logs with multidimensional filters and pagination
   */
  public async query(
    filters: AuditQueryFilters = {}
  ): Promise<{ logs: ZtaTransactionAuditEntry[]; total: number }> {
    const {
      limit = 100,
      offset = 0,
      start_time,
      end_time,
      client_id,
      upstream_id,
      tool_name,
      table,
      action_type,
      event_type,
      is_consistent,
      decision,
    } = filters;

    let filtered = this.cache;

    if (start_time) {
      const startMs = new Date(start_time).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= startMs);
    }

    if (end_time) {
      const endMs = new Date(end_time).getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= endMs);
    }

    if (client_id) {
      filtered = filtered.filter((e) => e.client.client_id === client_id);
    }

    if (upstream_id) {
      filtered = filtered.filter((e) => e.upstream.upstream_id === upstream_id);
    }

    if (tool_name) {
      filtered = filtered.filter((e) => e.upstream.tool_name === tool_name);
    }

    if (table) {
      const targetTableLower = table.toLowerCase();
      filtered = filtered.filter((e) =>
        e.sql_inspection?.target_tables.some((t) => t.toLowerCase() === targetTableLower)
      );
    }

    if (action_type) {
      filtered = filtered.filter((e) => e.sql_inspection?.action_type === action_type);
    }

    if (event_type) {
      filtered = filtered.filter((e) => e.event_type === event_type);
    }

    if (typeof is_consistent === "boolean") {
      filtered = filtered.filter((e) => e.consistency?.is_consistent === is_consistent);
    }

    if (decision) {
      filtered = filtered.filter((e) => e.decision.policy_enforcement === decision);
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      logs: paginated,
      total,
    };
  }

  /**
   * Computes summary metrics for security dashboards
   */
  public async getSummary(): Promise<AuditSummaryStats> {
    let allowedCount = 0;
    let blockedCount = 0;
    let deviationCount = 0;
    const tableFrequency: Record<string, number> = {};
    const actionCounts: Record<SqlActionType, number> = {
      READ: 0,
      WRITE: 0,
      DDL: 0,
      TRANSACTION: 0,
      UNKNOWN: 0,
    };
    const clientCounts: Record<string, number> = {};

    for (const e of this.cache) {
      if (e.decision.policy_enforcement === "ALLOW") allowedCount++;
      if (e.decision.policy_enforcement === "DENY") blockedCount++;
      if (e.consistency && !e.consistency.is_consistent) deviationCount++;

      const cId = e.client.client_id || "anonymous";
      clientCounts[cId] = (clientCounts[cId] || 0) + 1;

      if (e.sql_inspection) {
        const action = e.sql_inspection.action_type || "UNKNOWN";
        actionCounts[action] = (actionCounts[action] || 0) + 1;

        for (const tbl of e.sql_inspection.target_tables) {
          tableFrequency[tbl] = (tableFrequency[tbl] || 0) + 1;
        }
      }
    }

    const topTables = Object.entries(tableFrequency)
      .map(([table, count]) => ({ table, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total_transactions: this.cache.length,
      allowed_count: allowedCount,
      blocked_count: blockedCount,
      deviation_count: deviationCount,
      top_tables: topTables,
      action_breakdown: actionCounts,
      client_breakdown: clientCounts,
    };
  }
}

export const defaultAuditStorage = new AuditStorage();
