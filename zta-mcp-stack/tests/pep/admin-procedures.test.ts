import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maskTools, isToolCallAllowed } from "../../src/pep/masking.js";
import { ToolDefinition, UpstreamConfig } from "../../src/types/index.js";

describe("Digital Agency Administrative Procedures PEP & Context Masking", () => {
  const adminProceduresTools: ToolDefinition[] = [
    { name: "list_datasets", description: "List available administrative datasets", inputSchema: { type: "object" } },
    { name: "inspect_dataset", description: "Inspect schema and stats of a dataset", inputSchema: { type: "object" } },
    { name: "query_records", description: "Query individual administrative procedure records", inputSchema: { type: "object" } },
    { name: "summarize_records", description: "Summarize records with aggregation and grouping", inputSchema: { type: "object" } },
    { name: "execute_system_command", description: "Dangerous command execution (hypothetical)", inputSchema: { type: "object" } },
  ];

  const adminProceduresUpstream: UpstreamConfig = {
    id: "admin-procedures",
    path: "/mcp/admin-procedures",
    target: "http://127.0.0.1:33070/mcp",
    policies: {
      role_mappings: {
        guest: { allowed_tools: [] },
        analyst: {
          allowed_tools: [
            "list_datasets",
            "inspect_dataset",
            "query_records",
            "summarize_records",
          ],
        },
        admin: { allowed_tools: ["*"] },
      },
    },
  };

  test("analyst role sees only authorized administrative analysis tools", () => {
    const masked = maskTools(adminProceduresTools, ["analyst"], adminProceduresUpstream);
    assert.equal(masked.length, 4);
    assert.deepEqual(
      masked.map((t) => t.name),
      ["list_datasets", "inspect_dataset", "query_records", "summarize_records"]
    );
    // Unauthorized tools must be completely stripped from AI context
    assert.equal(masked.some((t) => t.name === "execute_system_command"), false);
  });

  test("guest role sees zero tools (Complete Masking)", () => {
    const masked = maskTools(adminProceduresTools, ["guest"], adminProceduresUpstream);
    assert.equal(masked.length, 0);
  });

  test("admin role with wildcard sees all tools", () => {
    const masked = maskTools(adminProceduresTools, ["admin"], adminProceduresUpstream);
    assert.equal(masked.length, 5);
  });

  test("isToolCallAllowed enforces tool permission strictly", () => {
    assert.equal(isToolCallAllowed("summarize_records", ["analyst"], adminProceduresUpstream), true);
    assert.equal(isToolCallAllowed("query_records", ["analyst"], adminProceduresUpstream), true);
    assert.equal(isToolCallAllowed("inspect_dataset", ["analyst"], adminProceduresUpstream), true);
    assert.equal(isToolCallAllowed("list_datasets", ["analyst"], adminProceduresUpstream), true);
    assert.equal(isToolCallAllowed("execute_system_command", ["analyst"], adminProceduresUpstream), false);

    assert.equal(isToolCallAllowed("summarize_records", ["guest"], adminProceduresUpstream), false);
    assert.equal(isToolCallAllowed("execute_system_command", ["admin"], adminProceduresUpstream), true);
  });
});
