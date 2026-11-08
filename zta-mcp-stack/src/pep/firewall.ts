import nodeSqlParser from "node-sql-parser";
import { FirewallConfig, PepDecision } from "../types/index.js";

const { Parser } = nodeSqlParser;
const parser = new Parser();

/**
 * Validates a SQL query string against the configured Firewall rules.
 */
export function validateSqlQuery(
  query: string,
  firewallConfig?: FirewallConfig,
  clientRoles: string[] = []
): PepDecision {
  // If no firewall rules or check is disabled, allow
  if (!firewallConfig || !firewallConfig.enforce_sql_check) {
    return { allowed: true };
  }

  // Check if any of client's roles are restricted by firewall
  if (firewallConfig.restricted_roles && firewallConfig.restricted_roles.length > 0) {
    const isRestricted = clientRoles.some((role) =>
      firewallConfig.restricted_roles!.includes(role)
    );
    // If client does not belong to any restricted role (e.g. admin), pass through
    if (!isRestricted) {
      return { allowed: true };
    }
  }

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return {
      allowed: false,
      reason: "Empty or invalid query string",
      ruleViolated: "EMPTY_QUERY",
    };
  }

  const trimmed = query.trim();

  // 1. Pre-check: Simple fast check for dangerous patterns before full AST
  // Disallow semicolon followed by non-whitespace (potential unparsed multi-statements)
  const statementsCount = trimmed.split(";").filter((s) => s.trim().length > 0).length;
  if (statementsCount > 1) {
    return {
      allowed: false,
      reason: "Execution denied: Multiple statements are strictly forbidden.",
      ruleViolated: "MULTI_STATEMENT_FORBIDDEN",
      details: { detectedStatements: statementsCount },
    };
  }

  // 2. Parse SQL AST
  let ast: any;
  try {
    ast = parser.astify(trimmed);
  } catch (err: any) {
    // Fail-Closed: unparseable queries are rejected
    return {
      allowed: false,
      reason: `Execution denied: Failed to parse SQL query safely (${err.message}).`,
      ruleViolated: "SQL_PARSE_ERROR",
      details: { error: err.message },
    };
  }

  // Ensure AST is a single statement
  const astList = Array.isArray(ast) ? ast : [ast];
  if (astList.length > 1) {
    return {
      allowed: false,
      reason: "Execution denied: Multi-statement AST detected.",
      ruleViolated: "MULTI_STATEMENT_FORBIDDEN",
    };
  }

  const singleAst = astList[0];
  if (!singleAst || !singleAst.type) {
    return {
      allowed: false,
      reason: "Execution denied: Unknown or ambiguous SQL statement type.",
      ruleViolated: "UNKNOWN_STATEMENT_TYPE",
    };
  }

  const stmtType = String(singleAst.type).toUpperCase();

  // 3. Deny Statements Check
  const denyStatements = (firewallConfig.deny_statements || [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "RENAME",
    "GRANT",
    "REVOKE",
  ]).map((s) => s.toUpperCase());

  if (denyStatements.includes(stmtType)) {
    return {
      allowed: false,
      reason: `Execution denied: Statement type '${stmtType}' is forbidden by ZTA policy.`,
      ruleViolated: "DENIED_STATEMENT_TYPE",
      details: { statementType: stmtType },
    };
  }

  // 4. Allowed Statements Check
  if (firewallConfig.allowed_statements && firewallConfig.allowed_statements.length > 0) {
    const allowedStatements = firewallConfig.allowed_statements.map((s) => s.toUpperCase());
    if (!allowedStatements.includes(stmtType)) {
      return {
        allowed: false,
        reason: `Execution denied: Statement type '${stmtType}' is not in allowed list (${allowedStatements.join(", ")}).`,
        ruleViolated: "NOT_ALLOWED_STATEMENT_TYPE",
        details: { statementType: stmtType, allowedStatements },
      };
    }
  }

  return {
    allowed: true,
    details: { statementType: stmtType },
  };
}
