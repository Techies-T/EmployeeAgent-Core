import crypto from "node:crypto";
import nodeSqlParser from "node-sql-parser";
import { SqlActionType, SqlInspectionResult } from "../types/audit.js";

const { Parser } = nodeSqlParser;
const parser = new Parser();

/**
 * Sanitizes raw SQL query by masking sensitive string literals and credentials
 */
export function sanitizeSqlQuery(sql: string): string {
  if (!sql) return "";
  // Mask string literals in single quotes: 'secret' -> '***'
  let sanitized = sql.replace(/'(?:[^'\\]|\\.)*'/g, "'***'");
  // Mask string literals in double quotes: "secret" -> "***"
  sanitized = sanitized.replace(/"(?:[^"\\]|\\.)*"/g, '"***"');
  // Collapse whitespace
  return sanitized.trim();
}

/**
 * Computes SHA-256 fingerprint hash of query
 */
export function computeQueryFingerprint(sql: string): string {
  return crypto.createHash("sha256").update(sql.trim()).digest("hex");
}

/**
 * Deeply inspects an SQL query using AST parsing
 * Extracts target tables, action type (READ/WRITE/DDL), and checks safety
 */
export function inspectSqlQuery(rawSql: string): SqlInspectionResult {
  if (!rawSql || typeof rawSql !== "string" || rawSql.trim().length === 0) {
    return {
      is_sql: false,
      action_type: "UNKNOWN",
      target_tables: [],
      sanitized_query: "",
      query_fingerprint: "",
      has_subquery: false,
      is_multi_statement: false,
      error: "Empty query string",
    };
  }

  const trimmed = rawSql.trim();
  const sanitized = sanitizeSqlQuery(trimmed);
  const fingerprint = computeQueryFingerprint(trimmed);

  // Check multi-statement before AST
  const statementsCount = trimmed.split(";").filter((s) => s.trim().length > 0).length;
  const isMultiStatement = statementsCount > 1;

  let ast: any;
  let targetTables: string[] = [];
  let accessedColumns: string[] = [];
  let actionType: SqlActionType = "UNKNOWN";
  let hasSubquery = false;

  try {
    ast = parser.astify(trimmed);
  } catch (err: any) {
    // If AST parsing fails, attempt regex fallback for table extraction
    const tableMatches = trimmed.match(/(?:from|into|update|join)\s+([`"]?\w+[`"]?)/gi) || [];
    const fallbackTables = Array.from(
      new Set(
        tableMatches.map((m) =>
          m.replace(/(?:from|into|update|join)\s+/i, "").replace(/[`"]/g, "").trim()
        )
      )
    );

    // Basic heuristic for action
    const firstWord = (trimmed.split(/\s+/)[0] || "").toUpperCase();
    if (["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"].includes(firstWord)) {
      actionType = "READ";
    } else if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(firstWord)) {
      actionType = "WRITE";
    } else if (["CREATE", "DROP", "ALTER", "TRUNCATE"].includes(firstWord)) {
      actionType = "DDL";
    }

    return {
      is_sql: true,
      action_type: actionType,
      target_tables: fallbackTables,
      sanitized_query: sanitized,
      query_fingerprint: fingerprint,
      has_subquery: false,
      is_multi_statement: isMultiStatement,
      error: `SQL Parse Warning: ${err.message}`,
    };
  }

  // Extract tables using parser.tableList
  try {
    const rawTableList = parser.tableList(trimmed);
    if (Array.isArray(rawTableList)) {
      targetTables = Array.from(
        new Set(
          rawTableList
            .map((item: string) => {
              const parts = item.split("::");
              return parts[parts.length - 1];
            })
            .filter((t) => Boolean(t) && t !== "null")
        )
      );
    }
  } catch {
    // Fallback if tableList errors
  }

  // Extract columns
  try {
    const rawColList = parser.columnList(trimmed);
    if (Array.isArray(rawColList)) {
      accessedColumns = Array.from(
        new Set(
          rawColList
            .map((item: string) => {
              const parts = item.split("::");
              return parts[parts.length - 1];
            })
            .filter((c) => Boolean(c) && c !== "null" && c !== "(.*)")
        )
      );
    }
  } catch {
    // Ignore columnList errors
  }

  // Determine action type from AST
  const astList = Array.isArray(ast) ? ast : [ast];
  const primaryAst = astList[0];

  if (primaryAst && primaryAst.type) {
    const typeUpper = String(primaryAst.type).toUpperCase();
    switch (typeUpper) {
      case "SELECT":
        actionType = "READ";
        break;
      case "INSERT":
      case "UPDATE":
      case "DELETE":
      case "REPLACE":
        actionType = "WRITE";
        break;
      case "CREATE":
      case "DROP":
      case "ALTER":
      case "TRUNCATE":
      case "RENAME":
        actionType = "DDL";
        break;
      default:
        actionType = "UNKNOWN";
        break;
    }
  }

  // Check subquery presence
  const astString = JSON.stringify(ast);
  hasSubquery = astString.includes('"expr":{"type":"select"') || (astList.length > 1);

  return {
    is_sql: true,
    action_type: actionType,
    target_tables: targetTables,
    accessed_columns: accessedColumns.length > 0 ? accessedColumns : undefined,
    sanitized_query: sanitized,
    query_fingerprint: fingerprint,
    has_subquery: hasSubquery,
    is_multi_statement: isMultiStatement,
  };
}
