import jwt from "jsonwebtoken";
import assert from "node:assert/strict";

const GATEWAY_URL = "http://127.0.0.1:8085";
const JWT_SECRET = "e2e-secret-key-1234";

const analystToken = jwt.sign(
  { sub: "agent-baseball-analyst", roles: ["analyst"] },
  JWT_SECRET,
  { issuer: "https://auth.techies.tokyo", audience: "zta-mcp-gateway", expiresIn: "1h" }
);

async function main() {
  console.log("⚾ Testing ZTA MCP Gateway query for NPB Baseball Analytics...");

  // Query Central League Standings
  const res = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
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
        arguments: {
          query: "SELECT team_name, wins, losses, win_rate, games_behind FROM teams WHERE league = 'Central' ORDER BY win_rate DESC;",
        },
      },
      id: 101,
    }),
  });

  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  const rows = JSON.parse(data.result?.content?.[0]?.text);
  console.log("✅ Central League Standings via ZTA MCP Gateway:");
  console.table(rows);

  // Query Top Hitters
  const res2 = await fetch(`${GATEWAY_URL}/mcp/mariadb`, {
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
        arguments: {
          query: "SELECT p.name, t.team_name, b.batting_avg, b.home_runs, b.ops FROM batting_stats b JOIN players p ON b.player_id = p.player_id JOIN teams t ON p.team_id = t.team_id ORDER BY b.ops DESC LIMIT 5;",
        },
      },
      id: 102,
    }),
  });

  assert.equal(res2.status, 200);
  const data2 = (await res2.json()) as any;
  const rows2 = JSON.parse(data2.result?.content?.[0]?.text);
  console.log("\n✅ Top 5 OPS Leaders via ZTA MCP Gateway:");
  console.table(rows2);
}

main().catch(console.error);
