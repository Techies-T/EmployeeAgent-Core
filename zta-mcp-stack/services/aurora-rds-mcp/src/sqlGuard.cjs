"use strict";

/**
 * SQL Guard for Aurora/RDS MCP Server
 *
 * Enforces strict Read-Only SQL protection when DB_READ_ONLY=true:
 * - Only allows SELECT, SHOW, DESCRIBE, DESC, EXPLAIN statements
 * - Blocks multi-statement injection (; ...)
 * - Blocks write/DDL/privilege statements and locking/file-export clauses
 * - Ignores string literals and backtick-quoted identifiers when scanning tokens
 */

const ALLOWED_READ_ONLY_KEYWORDS = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
]);

const FORBIDDEN_WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "REPLACE",
  "GRANT",
  "REVOKE",
  "CALL",
  "LOAD",
  "LOCK",
  "UNLOCK",
  "SET",
  "RENAME",
  "HANDLER",
  "PURGE",
  "RESET",
  "SHUTDOWN",
  "KILL",
  "INSTALL",
  "UNINSTALL",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
];

const FORBIDDEN_CLAUSES_REGEX = [
  /\bINTO\s+OUTFILE\b/i,
  /\bINTO\s+DUMPFILE\b/i,
  /\bFOR\s+UPDATE\b/i,
  /\bFOR\s+SHARE\b/i,
  /\bLOCK\s+IN\s+SHARE\s+MODE\b/i,
];

/**
 * Replaces SQL string literals ('...', "..."), backtick identifiers (`...`),
 * and SQL comments (-- ..., # ..., /* ... *\/) with spaces so keyword/semicolon
 * inspection cannot be bypassed by comments or triggered falsely by literal values.
 *
 * @param {string} sql
 * @returns {string}
 */
function stripCommentsAndLiterals(sql) {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      // MySQL conditional comments /*!50000 ... */ can execute SQL!
      // Treat /*! ... */ as executable by stripping only the wrapper.
      if (i + 2 < len && sql[i + 2] === "!") {
        out += " ";
        i += 3;
        // Skip optional version digits
        while (i < len && /[0-9]/.test(sql[i])) i++;
        continue;
      }
      out += " ";
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    // End of conditional comment */
    if (ch === "*" && next === "/") {
      out += " ";
      i += 2;
      continue;
    }

    // Line comment -- ... (MySQL requires whitespace/control after --) or # ...
    if (
      (ch === "-" && next === "-" && (i + 2 >= len || /\s/.test(sql[i + 2]))) ||
      ch === "#"
    ) {
      out += " ";
      while (i < len && sql[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Single-quoted, double-quoted, or backtick-quoted literal/identifier
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += " ";
      i++;
      while (i < len) {
        if (sql[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (i + 1 < len && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Validates a SQL query against Read-Only and injection rules.
 *
 * @param {string} query
 * @param {{ readOnly?: boolean }} [options]
 * @returns {{ allowed: boolean, reason?: string, statementType?: string }}
 */
function validateSqlQuery(query, options = {}) {
  const readOnly = options.readOnly !== undefined ? Boolean(options.readOnly) : true;

  if (typeof query !== "string" || query.trim().length === 0) {
    return { allowed: false, reason: "SQL query must be a non-empty string." };
  }

  const sanitized = stripCommentsAndLiterals(query).trim();
  if (!sanitized) {
    return { allowed: false, reason: "SQL query contains no executable statement." };
  }

  // Block multi-statement queries (allow a single optional trailing semicolon)
  const withoutTrailingSemicolon = sanitized.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    return {
      allowed: false,
      reason: "Multi-statement SQL queries are blocked for security.",
    };
  }

  // Extract the leading SQL keyword
  const firstTokenMatch = withoutTrailingSemicolon.match(/^([A-Za-z]+)/);
  if (!firstTokenMatch) {
    return {
      allowed: false,
      reason: "Unable to determine SQL statement type.",
    };
  }

  const statementType = firstTokenMatch[1].toUpperCase();

  if (!readOnly) {
    return { allowed: true, statementType };
  }

  if (!ALLOWED_READ_ONLY_KEYWORDS.has(statementType)) {
    return {
      allowed: false,
      statementType,
      reason: `Read-Only mode is enabled: '${statementType}' statements are blocked. Only SELECT, SHOW, DESCRIBE, and EXPLAIN are allowed.`,
    };
  }

  // Check for forbidden write/DDL keywords anywhere in the sanitized query
  for (const kw of FORBIDDEN_WRITE_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(withoutTrailingSemicolon)) {
      return {
        allowed: false,
        statementType,
        reason: `Read-Only mode is enabled: forbidden SQL keyword '${kw}' detected.`,
      };
    }
  }

  // Check for forbidden locking / file-export clauses
  for (const clauseRegex of FORBIDDEN_CLAUSES_REGEX) {
    if (clauseRegex.test(withoutTrailingSemicolon)) {
      return {
        allowed: false,
        statementType,
        reason: `Read-Only mode is enabled: forbidden SQL clause detected (${clauseRegex.source}).`,
      };
    }
  }

  return { allowed: true, statementType };
}

/**
 * Validates a table name (supports optional `schema.table`) against SQL injection.
 *
 * @param {string} tableName
 * @returns {{ valid: boolean, parts?: string[], reason?: string }}
 */
function validateTableName(tableName) {
  if (typeof tableName !== "string" || tableName.trim().length === 0) {
    return { valid: false, reason: "table_name is required." };
  }

  const trimmed = tableName.trim();
  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$/.test(trimmed)) {
    return {
      valid: false,
      reason: "Invalid table_name format. Only alphanumeric characters, underscores, and an optional schema prefix are allowed.",
    };
  }

  const parts = trimmed.split(".");
  if (parts.some((p) => p.length === 0 || p.length > 128)) {
    return { valid: false, reason: "Table or schema identifier exceeds maximum length." };
  }

  return { valid: true, parts };
}

module.exports = {
  ALLOWED_READ_ONLY_KEYWORDS,
  FORBIDDEN_WRITE_KEYWORDS,
  stripCommentsAndLiterals,
  validateSqlQuery,
  validateTableName,
};
