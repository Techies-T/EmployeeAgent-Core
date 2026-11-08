#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

// MariaDB Connection Pool
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

const server = new Server(
  {
    name: "mariadb-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_tables",
        description: "List all tables in the database",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "describe_table",
        description: "Get schema information for a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table_name: {
              type: "string",
              description: "The name of the table to describe",
            },
          },
          required: ["table_name"],
        },
      },
      {
        name: "execute_query",
        description: "Execute a SELECT query against the database",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The SQL SELECT query to execute",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_tables") {
      const dbName = process.env.DB_NAME || "testdb";
      const [rows] = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
        [dbName]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    } 
    
    else if (name === "describe_table") {
      const tableName = args?.table_name;
      if (!tableName) {
        throw new Error("table_name is required");
      }
      // Basic validation against SQL injection by allowing only alphanumerics/underscores
      if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
         throw new Error("Invalid table name format");
      }
      
      const [rows] = await pool.query(`DESCRIBE \`${tableName}\``);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    } 
    
    else if (name === "execute_query") {
      const query = args?.query;
      if (!query) {
        throw new Error("query is required");
      }
      // Restrict to read-only queries for safety during demo
      const normalizedQuery = query.trim().toUpperCase();
      if (!normalizedQuery.startsWith("SELECT") && !normalizedQuery.startsWith("SHOW")) {
         throw new Error("Only SELECT or SHOW queries are allowed for safety");
      }

      const [rows] = await pool.query(query);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }
    
    else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MariaDB MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
