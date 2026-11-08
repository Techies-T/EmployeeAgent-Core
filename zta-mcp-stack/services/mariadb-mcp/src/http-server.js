import http from "node:http";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const PORT = parseInt(process.env.MCP_PORT || "33060");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "testuser",
  password: process.env.DB_PASSWORD || "testpassword",
  database: process.env.DB_NAME || "testdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const toolsDefinition = [
  {
    name: "list_tables",
    description: "List all tables in MariaDB",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_table",
    description: "Get schema information for a specific table",
    inputSchema: {
      type: "object",
      properties: { table_name: { type: "string" } },
      required: ["table_name"],
    },
  },
  {
    name: "read_query",
    description: "Execute a SELECT query against the database",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "write_query",
    description: "Execute an INSERT, UPDATE, or DELETE query against the database",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "drop_table",
    description: "Drop a table from the database",
    inputSchema: {
      type: "object",
      properties: { table_name: { type: "string" } },
      required: ["table_name"],
    },
  },
];

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "healthy", service: "upstream-mariadb-mcp" }));
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const mcpReq = JSON.parse(body);

        // 1. tools/list
        if (mcpReq.method === "tools/list") {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: mcpReq.id,
              result: { tools: toolsDefinition },
            })
          );
          return;
        }

        // 2. tools/call
        if (mcpReq.method === "tools/call") {
          const { name, arguments: args } = mcpReq.params || {};

          if (name === "list_tables") {
            const dbName = process.env.DB_NAME || "testdb";
            const [rows] = await pool.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
              [dbName]
            );
            res.writeHead(200);
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: mcpReq.id,
                result: { content: [{ type: "text", text: JSON.stringify(rows) }] },
              })
            );
            return;
          }

          if (name === "describe_table") {
            const tableName = args?.table_name;
            const [rows] = await pool.query(`DESCRIBE \`${tableName}\``);
            res.writeHead(200);
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: mcpReq.id,
                result: { content: [{ type: "text", text: JSON.stringify(rows) }] },
              })
            );
            return;
          }

          if (name === "read_query") {
            const query = args?.query;
            const [rows] = await pool.query(query);
            res.writeHead(200);
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: mcpReq.id,
                result: { content: [{ type: "text", text: JSON.stringify(rows) }] },
              })
            );
            return;
          }

          if (name === "write_query") {
            const query = args?.query;
            const [result] = await pool.query(query);
            res.writeHead(200);
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: mcpReq.id,
                result: { content: [{ type: "text", text: JSON.stringify(result) }] },
              })
            );
            return;
          }

          if (name === "drop_table") {
            const tableName = args?.table_name;
            await pool.query(`DROP TABLE \`${tableName}\``);
            res.writeHead(200);
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: mcpReq.id,
                result: { content: [{ type: "text", text: `Table ${tableName} dropped` }] },
              })
            );
            return;
          }

          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: "2.0", id: mcpReq.id, error: { message: `Unknown tool: ${name}` } }));
          return;
        }

        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: mcpReq.id, error: { message: `Unsupported method: ${mcpReq.method}` } }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not Found" }));
});

const HOST = process.env.MCP_HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`[Upstream MariaDB MCP] Running at http://${HOST}:${PORT}`);
});
