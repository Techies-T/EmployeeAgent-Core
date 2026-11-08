/**
 * ZTA Transaction Audit Log Types
 * Zero Trust Architecture (NIST SP 800-207) Decoupled Audit Logging
 */

export type AuditEventType =
  | "TOOL_EXECUTION_SUCCESS"
  | "TOOL_EXECUTION_ERROR"
  | "FIREWALL_BLOCKED"
  | "POLICY_DEVIATION_DETECTED"
  | "AUTH_FAILED"
  | "ACCESS_ALLOWED"
  | "ACCESS_BLOCKED"
  | "CONFIG_LOADED";

export type SqlActionType = "READ" | "WRITE" | "DDL" | "TRANSACTION" | "UNKNOWN";

export type ConsistencyStatus =
  | "CONSISTENT"
  | "UNKNOWN_CATALOG"
  | "UNDEFINED_TABLE_ACCESS"
  | "WRITE_ON_READ_ONLY_TOOL"
  | "ROLE_UNAUTHORIZED"
  | "SUSPICIOUS_SYNTAX";

export interface SqlInspectionResult {
  is_sql: boolean;
  action_type: SqlActionType;
  target_tables: string[];
  accessed_columns?: string[];
  sanitized_query: string;
  query_fingerprint: string;
  has_subquery: boolean;
  is_multi_statement: boolean;
  error?: string;
}

export interface ConsistencyResult {
  catalog_id?: string;
  is_consistent: boolean;
  status: ConsistencyStatus;
  deviations: string[];
}

export interface ZtaTransactionAuditEntry {
  // 1. Core Metadata
  transaction_id: string; // UUID v4
  timestamp: string; // ISO 8601 (UTC)
  event_type: AuditEventType;

  // 2. Client Context (Zero Trust Subject)
  client: {
    client_id: string;
    roles: string[];
    ip_address: string;
    user_agent?: string;
    user_id?: string | number | null;
    user_email?: string | null;
    user_name?: string | null;
    user_roles?: string[];
  };

  // 3. Upstream & Tool Target
  upstream: {
    upstream_id: string;
    target_endpoint?: string;
    tool_name: string;
  };

  // 4. SQL Deep Inspection
  sql_inspection?: SqlInspectionResult;

  // 5. YAML Meta Consistency
  consistency?: ConsistencyResult;

  // 6. Policy Decision & Result
  decision: {
    policy_enforcement: "ALLOW" | "DENY";
    deny_reason?: string;
    execution_time_ms: number;
    upstream_status_code?: number;
    error_message?: string;
  };

  // Arbitrary additional context
  details?: Record<string, any>;
}

export interface AuditQueryFilters {
  limit?: number;
  offset?: number;
  start_time?: string;
  end_time?: string;
  client_id?: string;
  upstream_id?: string;
  tool_name?: string;
  table?: string;
  action_type?: SqlActionType;
  event_type?: AuditEventType;
  is_consistent?: boolean;
  decision?: "ALLOW" | "DENY";
}

export interface AuditSummaryStats {
  total_transactions: number;
  allowed_count: number;
  blocked_count: number;
  deviation_count: number;
  top_tables: Array<{ table: string; count: number }>;
  action_breakdown: Record<SqlActionType, number>;
  client_breakdown: Record<string, number>;
}
