import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolDefinition, UpstreamConfig } from "../types/index.js";

interface PooledSseClient {
  client: Client;
  transport: SSEClientTransport;
  target: string;
}

const sseClientPool = new Map<string, PooledSseClient>();

/**
 * Determines whether an upstream target URL uses the MCP SSE transport.
 */
export function isSseTarget(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.pathname.replace(/\/+$/, "").endsWith("/sse");
  } catch {
    return target.trim().replace(/\/+$/, "").endsWith("/sse");
  }
}

async function closePooledClient(upstreamId: string): Promise<void> {
  const existing = sseClientPool.get(upstreamId);
  if (!existing) return;
  sseClientPool.delete(upstreamId);
  try {
    await existing.client.close();
  } catch {
    // Ignore close errors
  }
}

async function getOrCreateSseClient(upstream: UpstreamConfig): Promise<Client> {
  const existing = sseClientPool.get(upstream.id);
  if (existing && existing.target === upstream.target) {
    return existing.client;
  }

  if (existing) {
    await closePooledClient(upstream.id);
  }

  const transport = new SSEClientTransport(new URL(upstream.target));
  const client = new Client(
    { name: `zta-gateway-proxy-${upstream.id}`, version: "1.1.2" },
    { capabilities: {} }
  );

  transport.onclose = () => {
    const current = sseClientPool.get(upstream.id);
    if (current && current.transport === transport) {
      sseClientPool.delete(upstream.id);
    }
  };

  transport.onerror = () => {
    const current = sseClientPool.get(upstream.id);
    if (current && current.transport === transport) {
      sseClientPool.delete(upstream.id);
    }
  };

  await client.connect(transport);
  sseClientPool.set(upstream.id, { client, transport, target: upstream.target });
  return client;
}

/**
 * Lists tools from an upstream MCP server, supporting both SSE and HTTP JSON-RPC POST targets.
 */
export async function listUpstreamTools(upstream: UpstreamConfig): Promise<ToolDefinition[]> {
  if (isSseTarget(upstream.target)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await getOrCreateSseClient(upstream);
        const res = await client.listTools();
        return (res.tools || []) as ToolDefinition[];
      } catch (err) {
        await closePooledClient(upstream.id);
        if (attempt === 1) throw err;
      }
    }
    return [];
  }

  const upstreamRes = await fetch(upstream.target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });

  if (!upstreamRes.ok) {
    throw new Error(`Upstream HTTP ${upstreamRes.status} (${upstream.id})`);
  }

  const data = (await upstreamRes.json()) as any;
  if (data.error) {
    throw new Error(data.error.message || `Upstream tools/list error (${upstream.id})`);
  }
  return (data.result?.tools || []) as ToolDefinition[];
}

/**
 * Calls a tool on an upstream MCP server, supporting both SSE and HTTP JSON-RPC POST targets.
 */
export async function callUpstreamTool(
  upstream: UpstreamConfig,
  name: string,
  args: Record<string, any>
): Promise<any> {
  if (isSseTarget(upstream.target)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await getOrCreateSseClient(upstream);
        const result = await client.callTool({ name, arguments: args });
        return result || { content: [] };
      } catch (err) {
        await closePooledClient(upstream.id);
        if (attempt === 1) throw err;
      }
    }
    return { content: [] };
  }

  const upstreamRes = await fetch(upstream.target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: Date.now(),
    }),
  });

  const data = (await upstreamRes.json()) as any;
  if (data.error) {
    throw new Error(data.error.message || "Upstream execution error");
  }
  return data.result || { content: [] };
}
