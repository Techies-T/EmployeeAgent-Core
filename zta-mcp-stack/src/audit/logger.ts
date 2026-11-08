import crypto from "node:crypto";
import { ZtaTransactionAuditEntry } from "../types/audit.js";
import { defaultAuditStorage, AuditStorage } from "./storage.js";

export type AuditEventType =
  | "ACCESS_ALLOWED"
  | "ACCESS_BLOCKED"
  | "FIREWALL_VIOLATION"
  | "TOOL_EXECUTION"
  | "AUTH_FAILED"
  | "CONFIG_LOADED";

export interface AuditLogEntry {
  timestamp: string;
  event_id: string;
  event_type: AuditEventType;
  client_id?: string;
  roles?: string[];
  upstream_id?: string;
  method?: string;
  tool_name?: string;
  decision: "ALLOW" | "DENY" | "INFO";
  reason?: string;
  details?: Record<string, any>;
}

export class AuditLogger {
  private outputStream: (entryJson: string) => void;
  private storage: AuditStorage;

  constructor(customOutput?: (entryJson: string) => void, storage?: AuditStorage) {
    this.outputStream = customOutput || ((msg) => process.stdout.write(msg + "\n"));
    this.storage = storage || defaultAuditStorage;
  }

  /**
   * Legacy basic event logger (backward compatible)
   */
  log(params: Omit<AuditLogEntry, "timestamp" | "event_id">): AuditLogEntry {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      event_id: crypto.randomUUID(),
      ...params,
    };

    this.outputStream(JSON.stringify(entry));
    return entry;
  }

  /**
   * Logs a full ZTA transaction audit entry (Deep SQL inspection, YAML consistency, and execution result)
   */
  async logTransaction(entry: ZtaTransactionAuditEntry): Promise<void> {
    // 1. Output structured log to stdout (SIEM integration)
    this.outputStream(
      JSON.stringify({
        zta_audit: true,
        transaction_id: entry.transaction_id,
        timestamp: entry.timestamp,
        client_id: entry.client.client_id,
        upstream_id: entry.upstream.upstream_id,
        tool: entry.upstream.tool_name,
        action: entry.sql_inspection?.action_type,
        tables: entry.sql_inspection?.target_tables,
        consistent: entry.consistency?.is_consistent,
        decision: entry.decision.policy_enforcement,
        time_ms: entry.decision.execution_time_ms,
      })
    );

    // 2. Persist to independent tamper-evident storage
    await this.storage.save(entry);
  }

  getStorage(): AuditStorage {
    return this.storage;
  }
}

export const defaultAuditLogger = new AuditLogger();
