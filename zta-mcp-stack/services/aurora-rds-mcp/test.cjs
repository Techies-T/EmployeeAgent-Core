"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { validateSqlQuery, validateTableName } = require("./src/sqlGuard.cjs");
const {
  IamTokenManager,
  validateIamTokenFormat,
  SANDBOX_SIM_CREDENTIALS,
} = require("./src/iamTokenManager.cjs");
const {
  loadDbConfig,
  detectEngineFromVersion,
  buildTlsOptions,
} = require("./src/dbPool.cjs");
const { createAuroraRdsMcpServer } = require("./src/server.cjs");

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.stack || err.message}`);
  }
}

/**
 * Invokes httpServer directly in-process without binding a TCP port
 * (works even in strict network-isolated sandboxes).
 */
function dispatchHttp(httpServer, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = urlPath;
    req.headers = { host: "127.0.0.1:33080" };

    const headers = {};
    let statusCode = 200;
    let data = "";

    const res = new PassThrough();
    res.headersSent = false;
    res.setHeader = (k, v) => {
      headers[String(k).toLowerCase()] = v;
    };
    res.getHeader = (k) => headers[String(k).toLowerCase()];
    res.writeHead = (code, hdrs = {}) => {
      statusCode = code;
      res.headersSent = true;
      for (const [k, v] of Object.entries(hdrs)) {
        headers[String(k).toLowerCase()] = v;
      }
      return res;
    };
    res.flushHeaders = () => {
      res.headersSent = true;
    };

    const origWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk) data += chunk.toString();
      return origWrite(chunk, ...rest);
    };

    const origEnd = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (chunk) data += chunk.toString();
      origEnd(chunk, ...rest);
      resolve({ statusCode, headers, body: data });
    };

    res.on("error", reject);
    httpServer.emit("request", req, res);

    if (body !== null) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

function dispatchSseFirstEvent(httpServer, urlPath) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = "GET";
    req.url = urlPath;
    req.headers = { host: "127.0.0.1:33080" };

    const headers = {};
    let statusCode = 200;
    let buf = "";
    let settled = false;

    const res = new PassThrough();
    res.headersSent = false;
    res.setHeader = (k, v) => {
      headers[String(k).toLowerCase()] = v;
    };
    res.getHeader = (k) => headers[String(k).toLowerCase()];
    res.writeHead = (code, hdrs = {}) => {
      statusCode = code;
      res.headersSent = true;
      for (const [k, v] of Object.entries(hdrs)) {
        headers[String(k).toLowerCase()] = v;
      }
      return res;
    };
    res.flushHeaders = () => {
      res.headersSent = true;
    };

    const origWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk) {
        buf += chunk.toString();
        if (!settled && buf.includes("event: endpoint")) {
          settled = true;
          req.emit("close");
          resolve({ statusCode, headers, body: buf });
        }
      }
      return origWrite(chunk, ...rest);
    };

    res.on("error", reject);
    httpServer.emit("request", req, res);
    req.end();
  });
}

async function main() {
  console.log("=== aurora-rds-mcp Unit Tests ===");

  // -------------------------------------------------------------------------
  // 1. SigV4 IAM Token Generation (@aws-sdk/rds-signer)
  // -------------------------------------------------------------------------
  await runTest("SigV4 IAM token generation produces valid AWS RDS connect token", async () => {
    const manager = new IamTokenManager({
      hostname: "mydb.cluster-abc123.ap-northeast-1.rds.amazonaws.com",
      port: 3306,
      username: "ea_iam_readonly",
      region: "ap-northeast-1",
      authMode: "iam",
      credentials: SANDBOX_SIM_CREDENTIALS,
    });

    const token = await manager.refreshToken();
    assert.equal(typeof token, "string");
    assert.ok(token.startsWith("mydb.cluster-abc123.ap-northeast-1.rds.amazonaws.com:3306/"));
    assert.ok(token.includes("Action=connect"));
    assert.ok(token.includes("DBUser=ea_iam_readonly"));
    assert.ok(token.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
    assert.ok(token.includes("X-Amz-Expires=900"));
    assert.ok(token.includes("X-Amz-Signature="));

    const check = validateIamTokenFormat(token);
    assert.equal(check.valid, true);
    assert.deepEqual(check.missing, []);

    const status = manager.getStatus();
    assert.equal(status.tokenValid, true);
    assert.equal(status.tokenFormatValid, true);
    assert.equal(status.refreshCount, 1);
    assert.ok(status.remainingSeconds > 800 && status.remainingSeconds <= 900);
    manager.stop();
  });

  await runTest("validateIamTokenFormat rejects invalid or protocol-prefixed tokens", () => {
    assert.equal(validateIamTokenFormat("").valid, false);
    assert.equal(validateIamTokenFormat("https://host:3306/?Action=connect").valid, false);
    assert.equal(validateIamTokenFormat("plain-password-123").valid, false);
  });

  // -------------------------------------------------------------------------
  // 2. Background Silent Refresh
  // -------------------------------------------------------------------------
  await runTest("Silent refresh periodically rotates token in background and calls onRefresh", async () => {
    let callbackCount = 0;
    const manager = new IamTokenManager({
      hostname: "sandbox-aurora.cluster-sim.ap-northeast-1.rds.amazonaws.com",
      port: 3306,
      username: "iam_readonly",
      region: "ap-northeast-1",
      authMode: "sandbox_sim",
      refreshIntervalMs: 40,
      onRefresh: () => {
        callbackCount += 1;
      },
    });

    await manager.refreshToken();
    assert.equal(manager.refreshCount, 1);
    assert.equal(callbackCount, 1);

    manager.startSilentRefresh();
    assert.equal(manager.getStatus().silentRefreshActive, true);

    await new Promise((resolve) => setTimeout(resolve, 140));
    manager.stop();
    assert.equal(manager.getStatus().silentRefreshActive, false);

    assert.ok(
      manager.refreshCount >= 3,
      `Expected refreshCount >= 3 after silent refresh interval, got ${manager.refreshCount}`
    );
    assert.equal(callbackCount, manager.refreshCount);
    assert.equal(manager.getStatus().tokenValid, true);
  });

  // -------------------------------------------------------------------------
  // 3. Read-Only SQL Guard
  // -------------------------------------------------------------------------
  await runTest("SQL Guard allows SELECT, SHOW, DESCRIBE, DESC, EXPLAIN in Read-Only mode", () => {
    const allowedQueries = [
      "SELECT * FROM npb_games LIMIT 10",
      "select count(*) as cnt, created_at, updated_at, deleted_at from audit_logs where action = 'DELETE';",
      "/* header comment */ SELECT id, name FROM users WHERE status = 'UPDATE'",
      "-- line comment\nSHOW TABLES",
      "DESCRIBE players",
      "DESC teams",
      "EXPLAIN SELECT * FROM scores WHERE team_id = 1",
    ];

    for (const q of allowedQueries) {
      const res = validateSqlQuery(q, { readOnly: true });
      assert.equal(res.allowed, true, `Expected query to be allowed: ${q} (reason: ${res.reason})`);
    }
  });

  await runTest("SQL Guard strictly blocks write/DDL/injection queries in Read-Only mode", () => {
    const blockedQueries = [
      "",
      "   ",
      "INSERT INTO users (name) VALUES ('mallory')",
      "UPDATE users SET role = 'admin' WHERE id = 1",
      "DELETE FROM users WHERE id = 1",
      "DROP TABLE users",
      "ALTER TABLE users ADD COLUMN hack INT",
      "TRUNCATE TABLE logs",
      "CREATE TABLE evil (id INT)",
      "REPLACE INTO users VALUES (1, 'x')",
      "GRANT ALL ON *.* TO 'evil'@'%'",
      "REVOKE SELECT ON testdb.* FROM 'user'@'%'",
      "SET GLOBAL max_connections = 1",
      "SELECT * FROM users; DROP TABLE users",
      "SELECT * FROM users INTO OUTFILE '/tmp/dump.csv'",
      "SELECT * FROM users FOR UPDATE",
      "/* comment */ DELETE FROM sessions",
      "/*!50000 DROP TABLE users */",
    ];

    for (const q of blockedQueries) {
      const res = validateSqlQuery(q, { readOnly: true });
      assert.equal(res.allowed, false, `Expected query to be blocked: ${q}`);
    }
  });

  await runTest("SQL Guard allows DML when readOnly=false, while still blocking multi-statement", () => {
    assert.equal(
      validateSqlQuery("INSERT INTO logs (msg) VALUES ('ok')", { readOnly: false }).allowed,
      true
    );
    assert.equal(
      validateSqlQuery("SELECT 1; DROP TABLE logs", { readOnly: false }).allowed,
      false
    );
  });

  await runTest("validateTableName accepts safe names and rejects SQL injection", () => {
    assert.equal(validateTableName("npb_games").valid, true);
    assert.equal(validateTableName("testdb.npb_games").valid, true);
    assert.equal(validateTableName("users; DROP TABLE x").valid, false);
    assert.equal(validateTableName("users` --").valid, false);
    assert.equal(validateTableName("").valid, false);
  });

  // -------------------------------------------------------------------------
  // 4. Engine Detection & TLS Config
  // -------------------------------------------------------------------------
  await runTest("Engine detection identifies Aurora MySQL, RDS MariaDB, and RDS MySQL", () => {
    assert.equal(detectEngineFromVersion("10.11.6-MariaDB-log", "auto"), "rds-mariadb");
    assert.equal(detectEngineFromVersion("8.0.mysql_aurora.3.05.2", "auto"), "aurora-mysql");
    assert.equal(detectEngineFromVersion("8.0.35", "auto"), "rds-mysql");
    assert.equal(detectEngineFromVersion("8.0.35", "aurora-mysql"), "aurora-mysql");

    const cfg = loadDbConfig({
      DB_AUTH_MODE: "iam",
      AURORA_RDS_HOST: "test.rds.amazonaws.com",
      DB_SSL_REJECT_UNAUTHORIZED: "true",
    });
    const tls = buildTlsOptions(cfg);
    assert.equal(tls.rejectUnauthorized, true);
    assert.equal(tls.minVersion, "TLSv1.2");
  });

  // -------------------------------------------------------------------------
  // 5. HTTP / SSE / JSON-RPC Server Endpoints
  // -------------------------------------------------------------------------
  await runTest("Server exposes /health, /mcp (tools/list + read-only block), and /sse", async () => {
    const config = loadDbConfig({
      DB_AUTH_MODE: "sandbox_sim",
      DB_READ_ONLY: "true",
      AURORA_RDS_ENGINE: "aurora-mysql",
      AWS_REGION: "ap-northeast-1",
    });
    const app = createAuroraRdsMcpServer({ config });
    await app.poolManager.tokenManager.refreshToken();

    try {
      // GET /health
      const healthRes = await dispatchHttp(app.httpServer, "GET", "/health");
      assert.equal(healthRes.statusCode, 200);
      const healthJson = JSON.parse(healthRes.body);
      assert.equal(healthJson.status, "healthy");
      assert.equal(healthJson.service, "aurora-rds-mcp");
      assert.equal(healthJson.authMode, "sandbox_sim");
      assert.equal(healthJson.readOnly, true);
      assert.equal(healthJson.iamToken.tokenFormatValid, true);

      // POST /mcp tools/list
      const listRes = await dispatchHttp(app.httpServer, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      assert.equal(listRes.statusCode, 200);
      const listJson = JSON.parse(listRes.body);
      const toolNames = listJson.result.tools.map((t) => t.name);
      assert.deepEqual(toolNames, [
        "list_tables",
        "describe_table",
        "execute_query",
        "check_connection_status",
      ]);

      // POST /mcp tools/call execute_query (blocked write)
      const blockedRes = await dispatchHttp(app.httpServer, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "execute_query",
          arguments: { query: "DROP TABLE players" },
        },
      });
      assert.equal(blockedRes.statusCode, 200);
      const blockedJson = JSON.parse(blockedRes.body);
      assert.equal(blockedJson.result.isError, true);
      assert.ok(blockedJson.result.content[0].text.includes("Blocked by SQL Guard"));

      // GET /sse emits event: endpoint with /message?sessionId=...
      const sseRes = await dispatchSseFirstEvent(app.httpServer, "/sse");
      assert.equal(sseRes.statusCode, 200);
      assert.ok(String(sseRes.headers["content-type"]).includes("text/event-stream"));
      assert.ok(sseRes.body.includes("/message?sessionId="));
    } finally {
      await app.shutdown();
    }
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
