import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maskTools, isToolCallAllowed } from "../../src/pep/masking.js";
import { ToolDefinition, UpstreamConfig } from "../../src/types/index.js";

describe("Context Masking PEP", () => {
  const mockTools: ToolDefinition[] = [
    { name: "read_query", description: "Executes SELECT queries", inputSchema: { type: "object" } },
    { name: "write_query", description: "Executes INSERT/UPDATE queries", inputSchema: { type: "object" } },
    { name: "drop_table", description: "Drops a table", inputSchema: { type: "object" } },
    { name: "list_tables", description: "Lists all database tables", inputSchema: { type: "object" } },
  ];

  const mockUpstream: UpstreamConfig = {
    id: "mariadb-upstream",
    path: "/mcp/mariadb",
    target: "http://localhost:33060/sse",
    policies: {
      role_mappings: {
        guest: { allowed_tools: [] },
        analyst: { allowed_tools: ["read_query", "list_tables"] },
        operator: { allowed_tools: ["read_query", "write_query", "list_tables"] },
        admin: { allowed_tools: ["*"] },
      },
    },
  };

  test("analyst role only sees read_query and list_tables", () => {
    const masked = maskTools(mockTools, ["analyst"], mockUpstream);
    assert.equal(masked.length, 2);
    assert.deepEqual(masked.map((t) => t.name), ["read_query", "list_tables"]);
    // Ensure write_query and drop_table are completely stripped
    assert.equal(masked.some((t) => t.name === "write_query"), false);
    assert.equal(masked.some((t) => t.name === "drop_table"), false);
  });

  test("operator role sees read_query, write_query, list_tables", () => {
    const masked = maskTools(mockTools, ["operator"], mockUpstream);
    assert.equal(masked.length, 3);
    assert.deepEqual(masked.map((t) => t.name), ["read_query", "write_query", "list_tables"]);
    assert.equal(masked.some((t) => t.name === "drop_table"), false);
  });

  test("admin role with wildcard sees all tools untouched", () => {
    const masked = maskTools(mockTools, ["admin"], mockUpstream);
    assert.equal(masked.length, 4);
    assert.deepEqual(masked.map((t) => t.name), ["read_query", "write_query", "drop_table", "list_tables"]);
  });

  test("guest role sees zero tools", () => {
    const masked = maskTools(mockTools, ["guest"], mockUpstream);
    assert.equal(masked.length, 0);
  });

  test("isToolCallAllowed enforces tool permission correctly", () => {
    assert.equal(isToolCallAllowed("read_query", ["analyst"], mockUpstream), true);
    assert.equal(isToolCallAllowed("write_query", ["analyst"], mockUpstream), false);
    assert.equal(isToolCallAllowed("drop_table", ["analyst"], mockUpstream), false);

    assert.equal(isToolCallAllowed("write_query", ["operator"], mockUpstream), true);
    assert.equal(isToolCallAllowed("drop_table", ["operator"], mockUpstream), false);

    assert.equal(isToolCallAllowed("drop_table", ["admin"], mockUpstream), true);
  });
});
