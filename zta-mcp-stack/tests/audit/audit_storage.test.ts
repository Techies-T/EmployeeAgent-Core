import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { AuditStorage } from "../../src/audit/storage.js";
import { ZtaTransactionAuditEntry } from "../../src/types/audit.js";

describe("AuditStorage Engine", () => {
  const testDir = path.resolve(process.cwd(), "data/test_audit");
  let storage: AuditStorage;

  before(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    storage = new AuditStorage({ logDir: testDir });
  });

  after(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("persists audit entries and queries them with filters", async () => {
    const entry1: ZtaTransactionAuditEntry = {
      transaction_id: "tx-001",
      timestamp: "2026-10-08T00:00:00.000Z",
      event_type: "TOOL_EXECUTION_SUCCESS",
      client: {
        client_id: "macosui-analyst",
        roles: ["analyst"],
        ip_address: "127.0.0.1",
      },
      upstream: {
        upstream_id: "mariadb",
        tool_name: "read_query",
      },
      sql_inspection: {
        is_sql: true,
        action_type: "READ",
        target_tables: ["batting_stats", "players"],
        sanitized_query: "SELECT * FROM batting_stats",
        query_fingerprint: "hash1",
        has_subquery: false,
        is_multi_statement: false,
      },
      consistency: {
        catalog_id: "npb_baseball_analytics",
        is_consistent: true,
        status: "CONSISTENT",
        deviations: [],
      },
      decision: {
        policy_enforcement: "ALLOW",
        execution_time_ms: 45,
        upstream_status_code: 200,
      },
    };

    const entry2: ZtaTransactionAuditEntry = {
      transaction_id: "tx-002",
      timestamp: "2026-10-08T00:01:00.000Z",
      event_type: "POLICY_DEVIATION_DETECTED",
      client: {
        client_id: "external-agent",
        roles: ["guest"],
        ip_address: "192.168.1.100",
      },
      upstream: {
        upstream_id: "mariadb",
        tool_name: "read_query",
      },
      sql_inspection: {
        is_sql: true,
        action_type: "READ",
        target_tables: ["users"],
        sanitized_query: "SELECT * FROM users",
        query_fingerprint: "hash2",
        has_subquery: false,
        is_multi_statement: false,
      },
      consistency: {
        catalog_id: "npb_baseball_analytics",
        is_consistent: false,
        status: "UNDEFINED_TABLE_ACCESS",
        deviations: ["Table 'users' is undefined"],
      },
      decision: {
        policy_enforcement: "ALLOW",
        execution_time_ms: 12,
        upstream_status_code: 200,
      },
    };

    await storage.save(entry1);
    await storage.save(entry2);

    // 1. Query all
    const all = await storage.query({});
    assert.strictEqual(all.total, 2);

    // 2. Query by table 'users'
    const usersQuery = await storage.query({ table: "users" });
    assert.strictEqual(usersQuery.total, 1);
    assert.strictEqual(usersQuery.logs[0].transaction_id, "tx-002");

    // 3. Query by consistency = false
    const deviationQuery = await storage.query({ is_consistent: false });
    assert.strictEqual(deviationQuery.total, 1);
    assert.strictEqual(deviationQuery.logs[0].client.client_id, "external-agent");

    // 4. Summary stats
    const summary = await storage.getSummary();
    assert.strictEqual(summary.total_transactions, 2);
    assert.strictEqual(summary.deviation_count, 1);
    assert.strictEqual(summary.top_tables.some((t) => t.table === "batting_stats"), true);
  });
});
