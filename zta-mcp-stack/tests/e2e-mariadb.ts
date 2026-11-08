import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

const GATEWAY_URL = "http://127.0.0.1:8085";
const JWT_SECRET = process.env.GATEWAY_JWT_SECRET || "e2e-secret-key-1234";

// Generate JWT tokens
const analystToken = jwt.sign(
  { sub: "agent-sales", roles: ["analyst"] },
  JWT_SECRET,
  { issuer: "https://auth.techies.tokyo", audience: "zta-mcp-gateway", expiresIn: "1h" }
);

const adminToken = jwt.sign(
  { sub: "agent-dba", roles: ["admin"] },
  JWT_SECRET,
  { issuer: "https://auth.techies.tokyo", audience: "zta-mcp-gateway", expiresIn: "1h" }
);

async function runTests() {
  console.log("================================================================================");
  console.log("🧪 Starting ZTA MCP Gateway + MariaDB E2E Verification Tests");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // Step 1: Unauthenticated request should be rejected (401 Unauthorized)
  // ---------------------------------------------------------------------------
  console.log("▶ [Step 1] Testing unauthenticated access blocking...");
  const unauthRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  assert.equal(unauthRes.status, 401, "Expected 401 Unauthorized for unauthenticated request");
  const unauthData = await unauthRes.json();
  console.log("  ✅ Step 1 PASSED: 401 Unauthorized correctly returned:", unauthData.error);

  // ---------------------------------------------------------------------------
  // Step 2: Context Masking for 'analyst' role
  // ---------------------------------------------------------------------------
  console.log("\n▶ [Step 2] Testing Context Masking for 'analyst' role (AI Visual Scoping)...");
  const listRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${analystToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
  });
  assert.equal(listRes.status, 200, "Expected 200 OK for tools/list");
  const listData = (await listRes.json()) as any;
  const returnedTools = listData.result?.tools?.map((t: any) => t.name) || [];
  console.log("  Visible tools for analyst:", returnedTools);

  assert.deepEqual(
    returnedTools.sort(),
    ["describe_table", "list_tables", "read_query"].sort(),
    "Analyst should ONLY see describe_table, list_tables, read_query"
  );
  assert.equal(returnedTools.includes("write_query"), false, "write_query MUST be stripped");
  assert.equal(returnedTools.includes("drop_table"), false, "drop_table MUST be stripped");
  console.log("  ✅ Step 2 PASSED: write_query and drop_table are completely masked from AI sight!");

  // ---------------------------------------------------------------------------
  // Step 3: Legitimate SELECT query against real MariaDB database
  // ---------------------------------------------------------------------------
  console.log("\n▶ [Step 3] Executing legitimate SELECT query against real MariaDB database...");
  const selectRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${analystToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "read_query",
        arguments: { query: "SELECT id, name, email FROM users ORDER BY id ASC LIMIT 2;" },
      },
      id: 3,
    }),
  });
  assert.equal(selectRes.status, 200, "Expected 200 OK for legitimate query");
  const selectData = (await selectRes.json()) as any;
  const contentText = selectData.result?.content?.[0]?.text;
  console.log("  MariaDB Result Content:", contentText);
  assert.match(contentText, /山田 太郎/, "Result must contain real database row: 山田 太郎");
  assert.match(contentText, /taro\.yamada@example\.com/, "Result must contain email: taro.yamada@example.com");
  console.log("  ✅ Step 3 PASSED: Successfully retrieved real data from MariaDB container!");

  // ---------------------------------------------------------------------------
  // Step 4: Probing forbidden tool 'write_query' directly (RBAC Gate)
  // ---------------------------------------------------------------------------
  console.log("\n▶ [Step 4] Probing forbidden tool 'write_query' directly with analyst role...");
  const writeRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${analystToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "write_query",
        arguments: { query: "INSERT INTO users (name, email) VALUES ('evil_ai', 'evil@ai.com');" },
      },
      id: 4,
    }),
  });
  assert.equal(writeRes.status, 403, "Expected 403 Forbidden for unauthorized tool call");
  const writeData = (await writeRes.json()) as any;
  console.log("  Gateway Block Message:", writeData.error?.message);
  assert.match(writeData.error?.message, /Tool 'write_query' is not permitted by ZTA policy/);
  console.log("  ✅ Step 4 PASSED: Direct tool probing blocked by ZTA PEP before reaching MariaDB!");

  // ---------------------------------------------------------------------------
  // Step 5: SQL Injection / Multi-statement DROP attack in read_query (Query Firewall)
  // ---------------------------------------------------------------------------
  console.log("\n▶ [Step 5] Attempting SQL Injection / DROP TABLE attack via read_query...");
  const attackRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${analystToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "read_query",
        arguments: { query: "SELECT 1; DROP TABLE orders; -- malicious multi-statement" },
      },
      id: 5,
    }),
  });
  assert.equal(attackRes.status, 403, "Expected 403 Forbidden for multi-statement attack");
  const attackData = (await attackRes.json()) as any;
  console.log("  Firewall Intercept Message:", attackData.error?.message);
  assert.match(attackData.error?.message, /Multiple statements are strictly forbidden/);

  // Verify the 'orders' table still exists in MariaDB
  const verifyRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${analystToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "read_query",
        arguments: { query: "SELECT COUNT(*) AS count FROM orders;" },
      },
      id: 6,
    }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyData = (await verifyRes.json()) as any;
  console.log("  Orders Table Verification:", verifyData.result?.content?.[0]?.text);
  assert.match(verifyData.result?.content?.[0]?.text, /"count":3/);
  console.log("  ✅ Step 5 PASSED: Query Firewall intercepted the attack! orders table is SAFE (3 rows preserved)!");

  // ---------------------------------------------------------------------------
  // Step 6: Verify Admin role has access to all tools (Wildcard *)
  // ---------------------------------------------------------------------------
  console.log("\n▶ [Step 6] Testing Admin role tool visibility (Wildcard *)...");
  const adminRes = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 7 }),
  });
  assert.equal(adminRes.status, 200);
  const adminData = (await adminRes.json()) as any;
  const adminTools = adminData.result?.tools?.map((t: any) => t.name) || [];
  console.log("  Visible tools for admin:", adminTools);
  assert.equal(adminTools.length, 5, "Admin should see all 5 tools");
  assert.equal(adminTools.includes("write_query"), true);
  assert.equal(adminTools.includes("drop_table"), true);
  console.log("  ✅ Step 6 PASSED: Admin role has full visibility as configured.");

  console.log("\n================================================================================");
  console.log("🎉 ALL E2E VERIFICATION TESTS PASSED SUCCESSFULLY! (6/6)");
  console.log("================================================================================");
}

runTests().catch((err) => {
  console.error("❌ E2E Test Failed:", err);
  process.exit(1);
});
