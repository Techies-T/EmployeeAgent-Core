import { test, describe } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { inspectSqlQuery, sanitizeSqlQuery } from "../../src/pep/sqlInspector.js";
import { checkPolicyConsistency } from "../../src/audit/consistencyEngine.js";
import { CatalogProvider } from "../../src/catalog/index.js";

describe("SQL Deep Inspector & Sanitization", () => {
  test("inspects complex SELECT query with JOINs, extracts tables and action type", () => {
    const sql = `
      SELECT p.name, t.team_name, b.war
      FROM batting_stats b
      JOIN players p ON b.player_id = p.player_id
      JOIN teams t ON p.team_id = t.team_id
      WHERE b.year = 2025 AND p.name = '佐藤 輝明'
      ORDER BY b.war DESC;
    `;

    const result = inspectSqlQuery(sql);
    assert.strictEqual(result.is_sql, true);
    assert.strictEqual(result.action_type, "READ");
    assert.deepStrictEqual(result.target_tables.sort(), ["batting_stats", "players", "teams"].sort());
    assert.strictEqual(result.is_multi_statement, false);
    // Sensitive string literal should be sanitized
    assert.ok(!result.sanitized_query.includes("佐藤 輝明"));
    assert.ok(result.sanitized_query.includes("'***'"));
  });

  test("detects WRITE operation and target table on UPDATE", () => {
    const sql = `UPDATE users SET role = 'admin' WHERE id = 10;`;
    const result = inspectSqlQuery(sql);
    assert.strictEqual(result.is_sql, true);
    assert.strictEqual(result.action_type, "WRITE");
    assert.deepStrictEqual(result.target_tables, ["users"]);
    assert.ok(result.sanitized_query.includes("'***'"));
  });

  test("detects DDL statement and DROP table", () => {
    const sql = `DROP TABLE batting_stats;`;
    const result = inspectSqlQuery(sql);
    assert.strictEqual(result.is_sql, true);
    assert.strictEqual(result.action_type, "DDL");
    assert.deepStrictEqual(result.target_tables, ["batting_stats"]);
  });

  test("detects multi-statement injection attempt", () => {
    const sql = `SELECT * FROM players; DROP TABLE users;`;
    const result = inspectSqlQuery(sql);
    assert.strictEqual(result.is_multi_statement, true);
  });
});

describe("YAML Meta Consistency Engine", () => {
  const catalogPath = path.resolve(process.cwd(), "config/catalog-definitions.yaml");
  const catalogProvider = new CatalogProvider(catalogPath);

  test("verifies consistency for legitimate NPB query with analyst role", () => {
    const sql = `SELECT * FROM batting_stats JOIN players ON batting_stats.player_id = players.player_id;`;
    const inspection = inspectSqlQuery(sql);

    const check = checkPolicyConsistency({
      upstreamId: "mariadb",
      toolName: "read_query",
      clientRoles: ["analyst"],
      sqlInspection: inspection,
      catalogProvider,
    });

    assert.strictEqual(check.is_consistent, true);
    assert.strictEqual(check.status, "CONSISTENT");
    assert.strictEqual(check.deviations.length, 0);
  });

  test("detects UNDEFINED_TABLE_ACCESS when querying undeclared table (e.g. users)", () => {
    const sql = `SELECT * FROM users WHERE id = 1;`;
    const inspection = inspectSqlQuery(sql);

    const check = checkPolicyConsistency({
      upstreamId: "mariadb",
      toolName: "read_query",
      clientRoles: ["analyst"],
      sqlInspection: inspection,
      catalogProvider,
    });

    assert.strictEqual(check.is_consistent, false);
    assert.strictEqual(check.status, "UNDEFINED_TABLE_ACCESS");
    assert.ok(check.deviations.some((d) => d.includes("users")));
  });

  test("detects WRITE_ON_READ_ONLY_TOOL when attempting UPDATE via read_query", () => {
    const sql = `UPDATE batting_stats SET war = 10.0 WHERE id = 1;`;
    const inspection = inspectSqlQuery(sql);

    const check = checkPolicyConsistency({
      upstreamId: "mariadb",
      toolName: "read_query",
      clientRoles: ["analyst"],
      sqlInspection: inspection,
      catalogProvider,
    });

    assert.strictEqual(check.is_consistent, false);
    assert.strictEqual(check.status, "WRITE_ON_READ_ONLY_TOOL");
    assert.ok(check.deviations.some((d) => d.includes("prohibited on read-only")));
  });
});
