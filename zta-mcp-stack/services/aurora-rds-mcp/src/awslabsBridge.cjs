"use strict";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

/**
 * Bridge to AWS official `awslabs.mysql-mcp-server` (mysqlwire_iam mode)
 * spawned via `uvx awslabs.mysql-mcp-server` over stdio and exposed via SSE/HTTP.
 */
class AwslabsMysqlBridge {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.connected = false;
    this.lastError = null;
    this.startedAt = null;
  }

  _buildSpawnArgs() {
    const command = process.env.AWSLABS_MYSQL_CMD || "uvx";
    const pkg = process.env.AWSLABS_MYSQL_PACKAGE || "awslabs.mysql-mcp-server@latest";
    const args = [pkg];

    if (this.config.auroraHost) {
      args.push("--hostname", this.config.auroraHost);
    }
    if (this.config.auroraPort) {
      args.push("--port", String(this.config.auroraPort));
    }
    if (this.config.auroraDatabase) {
      args.push("--database", this.config.auroraDatabase);
    }
    if (this.config.region) {
      args.push("--region", this.config.region);
    }
    if (this.config.readOnly) {
      args.push("--readonly", "true");
    }

    // Use mysqlwire_iam authentication mode supported by awslabs.mysql-mcp-server
    args.push("--auth_type", process.env.AWSLABS_MYSQL_AUTH_TYPE || "mysqlwire_iam");

    if (this.config.auroraUser) {
      args.push("--username", this.config.auroraUser);
    }

    return { command, args };
  }

  async connect() {
    if (this.connected && this.client) {
      return;
    }

    const { command, args } = this._buildSpawnArgs();
    const env = {
      ...process.env,
      AWS_REGION: this.config.region,
      FASTMCP_LOG_LEVEL: process.env.FASTMCP_LOG_LEVEL || "ERROR",
    };

    try {
      this.transport = new StdioClientTransport({
        command,
        args,
        env,
      });

      this.client = new Client(
        { name: "aurora-rds-mcp-awslabs-bridge", version: "1.0.0" },
        { capabilities: {} }
      );

      await this.client.connect(this.transport);
      this.connected = true;
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      console.log(
        `[aurora-rds-mcp] Connected to awslabs.mysql-mcp-server bridge (${command} ${args.join(" ")})`
      );
    } catch (err) {
      this.connected = false;
      this.lastError = `Failed to start awslabs.mysql-mcp-server via '${command}': ${err.message}. Build image with --build-arg ENABLE_AWSLABS_MYSQL=true or install uvx.`;
      throw new Error(this.lastError);
    }
  }

  async listTools() {
    await this.connect();
    const result = await this.client.listTools();
    return result.tools || [];
  }

  async callTool(name, args = {}) {
    await this.connect();
    return this.client.callTool({ name, arguments: args });
  }

  getStatus() {
    return {
      connected: this.connected,
      authMode: "awslabs_mysql",
      engine: this.config.engine,
      targetEndpoint: `${this.config.auroraHost}:${this.config.auroraPort}`,
      database: this.config.auroraDatabase,
      region: this.config.region,
      readOnly: this.config.readOnly,
      startedAt: this.startedAt,
      lastError: this.lastError,
      bridgeCommand: process.env.AWSLABS_MYSQL_CMD || "uvx",
      bridgeAuthType: process.env.AWSLABS_MYSQL_AUTH_TYPE || "mysqlwire_iam",
    };
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }
    this.transport = null;
    this.connected = false;
  }
}

module.exports = { AwslabsMysqlBridge };
