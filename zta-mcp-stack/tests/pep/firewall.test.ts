import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateSqlQuery } from "../../src/pep/firewall.js";
import { FirewallConfig } from "../../src/types/index.js";

describe("Query Firewall PEP", () => {
  const readOnlyFirewall: FirewallConfig = {
    enforce_sql_check: true,
    restricted_roles: ["analyst"],
    allowed_statements: ["SELECT"],
    deny_statements: ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE"],
  };

  test("allows legitimate SELECT queries for analyst role", () => {
    const result = validateSqlQuery("SELECT id, name FROM users WHERE active = 1", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, true);
    assert.equal(result.details?.statementType, "SELECT");
  });

  test("blocks UPDATE statements with DENIED_STATEMENT_TYPE", () => {
    const result = validateSqlQuery("UPDATE users SET active = 0 WHERE id = 10", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, false);
    assert.equal(result.ruleViolated, "DENIED_STATEMENT_TYPE");
    assert.match(result.reason!, /forbidden by ZTA policy/);
  });

  test("blocks DELETE statements", () => {
    const result = validateSqlQuery("DELETE FROM orders WHERE status = 'cancelled'", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, false);
    assert.equal(result.ruleViolated, "DENIED_STATEMENT_TYPE");
  });

  test("blocks DROP TABLE statements", () => {
    const result = validateSqlQuery("DROP TABLE customers", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, false);
    assert.equal(result.ruleViolated, "DENIED_STATEMENT_TYPE");
  });

  test("blocks multiple statements (semicolon injection attack)", () => {
    const result = validateSqlQuery("SELECT 1; DROP TABLE logs;", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, false);
    assert.equal(result.ruleViolated, "MULTI_STATEMENT_FORBIDDEN");
  });

  test("rejects malformed or unparseable queries safely (Fail-Closed)", () => {
    const result = validateSqlQuery("SELECT FROM WHERE ;;; INVALID SYNTAX !!!", readOnlyFirewall, ["analyst"]);
    assert.equal(result.allowed, false);
  });

  test("passes through when client is not in restricted_roles (e.g. admin)", () => {
    const result = validateSqlQuery("DROP TABLE temp_data", readOnlyFirewall, ["admin"]);
    assert.equal(result.allowed, true);
  });
});
