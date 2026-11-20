"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const dotenv = require("dotenv");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const { validateSqlQuery, validateTableName } = require("./sqlGuard.cjs");
const { AuroraRdsPoolManager, loadDbConfig } = require("./dbPool.cjs");
const { AwslabsMysqlBridge } = require("./awslabsBridge.cjs");

dotenv.config();

const SERVICE_NAME = "aurora-rds-mcp";
const SERVICE_VERSION = "1.0.0";

const NATIVE_TOOLS = [
  {
    name: "list_tables",
    description:
      "List all tables in the connected AWS Aurora (MySQL-compatible) or RDS (MariaDB / MySQL) database.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description: "Optional database/schema name (defaults to configured DB).",
        },
      },
    },
  },
  {
    name: "describe_table",
    description:
      "Get column and schema information for a specific table in Aurora / RDS.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The name of the table to describe (or schema.table).",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "execute_query",
    description:
      "Execute a SQL query against Aurora / RDS. When DB_READ_ONLY=true (default), strictly allows only SELECT, SHOW, DESCRIBE, and EXPLAIN statements.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The SQL query to execute.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "check_connection_status",
    description:
      "Check database connectivity, engine type (aurora-mysql / rds-mariadb / rds-mysql), IAM SigV4 authentication status, TLS state, and remaining IAM token validity.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Reads JSON body from an incoming HTTP request.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Request payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Creates the Aurora/RDS MCP HTTP + SSE server instance.
 */
function createAuroraRdsMcpServer(options = {}) {
  const config = options.config || loadDbConfig(process.env);
  const poolManager = options.poolManager || new AuroraRdsPoolManager(config);
  const awslabsBridge =
    config.authMode === "awslabs_mysql"
      ? options.awslabsBridge || new AwslabsMysqlBridge(config)
      : null;

  const startedAt = Date.now();
  const sseSessions = new Map(); // sessionId -> { transport, server, keepAliveTimer }

  async function listTools() {
    if (awslabsBridge) {
      try {
        const bridgedTools = await awslabsBridge.listTools();
        const hasStatusTool = bridgedTools.some(
          (t) => t.name === "check_connection_status"
        );
        return hasStatusTool
          ? bridgedTools
          : [...bridgedTools, NATIVE_TOOLS[3]];
      } catch (err) {
        console.error(
          "[aurora-rds-mcp] Failed to list tools from awslabs_mysql bridge:",
          err.message
        );
        return [NATIVE_TOOLS[3]];
      }
    }
    return NATIVE_TOOLS;
  }

  async function callTool(name, args = {}) {
    if (name === "check_connection_status") {
      const status = awslabsBridge
        ? awslabsBridge.getStatus()
        : await poolManager.checkConnectionStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    if (awslabsBridge) {
      // Apply Read-Only SQL guard even in awslabs_mysql bridge mode if a SQL argument is provided
      const sqlArg = args?.query || args?.sql;
      if (sqlArg && config.readOnly) {
        const check = validateSqlQuery(sqlArg, { readOnly: true });
        if (!check.allowed) {
          return {
            content: [{ type: "text", text: `Blocked by Read-Only SQL Guard: ${check.reason}` }],
            isError: true,
          };
        }
      }
      return awslabsBridge.callTool(name, args);
    }

    if (name === "list_tables") {
      const targetDb =
        typeof args?.database === "string" && args.database.trim()
          ? args.database.trim()
          : poolManager.getActiveDatabase();
      const [rows] = await poolManager.query(
        "SELECT table_name, table_type, engine, table_rows FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
        [targetDb]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }

    if (name === "describe_table") {
      const check = validateTableName(args?.table_name);
      if (!check.valid) {
        return {
          content: [{ type: "text", text: `Error: ${check.reason}` }],
          isError: true,
        };
      }
      const escaped = check.parts.map((p) => `\`${p}\``).join(".");
      const [rows] = await poolManager.query(`DESCRIBE ${escaped}`);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }

    if (name === "execute_query") {
      const query = args?.query;
      const validation = validateSqlQuery(query, { readOnly: config.readOnly });
      if (!validation.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `Blocked by SQL Guard: ${validation.reason}`,
            },
          ],
          isError: true,
        };
      }

      const [rows] = await poolManager.query(query);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }

    return {
      content: [{ type: "text", text: `Error: Unknown tool '${name}'` }],
      isError: true,
    };
  }

  function createMcpSessionServer() {
    const mcpServer = new Server(
      { name: SERVICE_NAME, version: SERVICE_VERSION },
      { capabilities: { tools: {} } }
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await listTools();
      return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params || {};
      try {
        return await callTool(name, args || {});
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });

    return mcpServer;
  }

  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for ZTA Gateway / Admin UI connectivity checks
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Health Check Endpoint (GET /health)
    if (req.method === "GET" && pathname === "/health") {
      const tokenStatus = awslabsBridge
        ? awslabsBridge.getStatus()
        : poolManager.tokenManager.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          authMode: config.authMode,
          engine: config.engine,
          readOnly: config.readOnly,
          activeSseSessions: sseSessions.size,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          iamToken: tokenStatus,
        })
      );
      return;
    }

    // 2. ZTA-compliant MCP SSE Transport Endpoint (GET /sse)
    if (req.method === "GET" && pathname === "/sse") {
      try {
        const transport = new SSEServerTransport("/message", res);
        const sessionId = transport.sessionId;
        const mcpServer = createMcpSessionServer();

        const keepAliveTimer = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            clearInterval(keepAliveTimer);
          }
        }, 15000);
        if (typeof keepAliveTimer.unref === "function") {
          keepAliveTimer.unref();
        }

        sseSessions.set(sessionId, { transport, mcpServer, keepAliveTimer });

        req.on("close", () => {
          clearInterval(keepAliveTimer);
          sseSessions.delete(sessionId);
        });

        await mcpServer.connect(transport);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    // 3. ZTA-compliant MCP SSE Message Endpoint (POST /message?sessionId=...)
    if (req.method === "POST" && pathname === "/message") {
      const sessionId = parsedUrl.searchParams.get("sessionId");
      const session = sessionId ? sseSessions.get(sessionId) : null;

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Invalid or expired SSE sessionId. Connect to GET /sse first.",
          })
        );
        return;
      }

      try {
        await session.transport.handlePostMessage(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    // 4. Direct JSON-RPC Endpoint (POST /mcp) for ZTA-MCP-Gateway upstream forwarding
    if (req.method === "POST" && (pathname === "/mcp" || pathname === "/")) {
      try {
        const rpcReq = await readJsonBody(req);

        if (rpcReq.method === "tools/list") {
          const tools = await listTools();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcReq.id ?? null,
              result: { tools },
            })
          );
          return;
        }

        if (rpcReq.method === "tools/call") {
          const { name, arguments: args } = rpcReq.params || {};
          const result = await callTool(name, args || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcReq.id ?? null,
              result,
            })
          );
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcReq.id ?? null,
            error: { code: -32601, message: `Unsupported method: ${rpcReq.method}` },
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: err.message },
          })
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  async function initialize() {
    if (awslabsBridge) {
      // Lazy-connect on first tool call so container starts cleanly even before DB is reachable
      console.log(
        `[aurora-rds-mcp] Configured in awslabs_mysql bridge mode (${config.auroraHost}:${config.auroraPort})`
      );
      return;
    }
    await poolManager.initialize();
  }

  async function shutdown() {
    for (const [, session] of sseSessions.entries()) {
      clearInterval(session.keepAliveTimer);
    }
    sseSessions.clear();
    if (awslabsBridge) {
      await awslabsBridge.close();
    }
    await poolManager.close();
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return {
    httpServer,
    poolManager,
    awslabsBridge,
    config,
    initialize,
    shutdown,
    listTools,
    callTool,
  };
}

if (require.main === module) {
  const PORT = parseInt(process.env.MCP_PORT || "33080", 10);
  const HOST = process.env.MCP_HOST || "0.0.0.0";

  const app = createAuroraRdsMcpServer();
  app
    .initialize()
    .catch((err) => {
      console.warn(
        `[aurora-rds-mcp] Initial pool/IAM setup warning (will retry on demand): ${err.message}`
      );
    })
    .finally(() => {
      app.httpServer.listen(PORT, HOST, () => {
        console.log(
          `[aurora-rds-mcp] Running at http://${HOST}:${PORT} (mode=${app.config.authMode}, readOnly=${app.config.readOnly}, SSE=/sse, Message=/message, Health=/health)`
        );
      });
    });

  const handleSignal = async (sig) => {
    console.log(`[aurora-rds-mcp] Received ${sig}, shutting down...`);
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

module.exports = {
  createAuroraRdsMcpServer,
  NATIVE_TOOLS,
};
