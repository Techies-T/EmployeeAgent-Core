"use strict";

const fs = require("node:fs");
const mysql = require("mysql2/promise");
const { IamTokenManager } = require("./iamTokenManager.cjs");

const DEFAULT_RDS_CA_PATH = "/etc/ssl/certs/rds-global-bundle.pem";

/**
 * Loads configuration from environment variables with clean fallbacks.
 */
function loadDbConfig(env = process.env) {
  const authMode = (env.DB_AUTH_MODE || "sandbox_sim").trim().toLowerCase();
  const engine = (env.AURORA_RDS_ENGINE || env.DB_ENGINE || "auto").trim().toLowerCase();
  const readOnly = (env.DB_READ_ONLY || "true").trim().toLowerCase() !== "false";

  const auroraHost = env.AURORA_RDS_HOST || env.DB_HOST || "";
  const auroraPort = parseInt(env.AURORA_RDS_PORT || env.DB_PORT || "3306", 10);
  const auroraUser = env.AURORA_RDS_USER || env.DB_USER || "iam_readonly";
  const auroraDatabase = env.AURORA_RDS_DATABASE || env.DB_NAME || "testdb";
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "ap-northeast-1";
  const roleArn = env.AURORA_RDS_ROLE_ARN || env.DB_IAM_ROLE_ARN || "";

  const sslCaPath = env.DB_SSL_CA_PATH || DEFAULT_RDS_CA_PATH;
  const sslRejectUnauthorized =
    (env.DB_SSL_REJECT_UNAUTHORIZED || "true").trim().toLowerCase() !== "false";

  // Local Sandbox MariaDB target (used only when DB_AUTH_MODE=sandbox_sim)
  const sandboxHost = env.SANDBOX_DB_HOST || env.DB_HOST || "test_mariadb";
  const sandboxPort = parseInt(env.SANDBOX_DB_PORT || env.DB_PORT || "3306", 10);
  const sandboxUser = env.SANDBOX_DB_USER || "testuser";
  const sandboxPassword = env.SANDBOX_DB_PASSWORD || "testpassword";
  const sandboxDatabase = env.SANDBOX_DB_NAME || env.AURORA_RDS_DATABASE || env.DB_NAME || "testdb";

  return {
    authMode,
    engine,
    readOnly,
    region,
    roleArn,
    auroraHost:
      auroraHost ||
      (authMode === "sandbox_sim"
        ? `sandbox-aurora.cluster-sim.${region}.rds.amazonaws.com`
        : "127.0.0.1"),
    auroraPort,
    auroraUser,
    auroraDatabase,
    sslCaPath,
    sslRejectUnauthorized,
    sandboxHost,
    sandboxPort,
    sandboxUser,
    sandboxPassword,
    sandboxDatabase,
    connectionLimit: parseInt(env.DB_CONNECTION_LIMIT || "10", 10),
  };
}

/**
 * Resolves TLS options for AWS Aurora / RDS IAM connections.
 * TLS is mandatory in IAM authentication mode.
 */
function buildTlsOptions(config) {
  const ssl = {
    rejectUnauthorized: config.sslRejectUnauthorized,
    minVersion: "TLSv1.2",
  };

  if (config.sslCaPath && fs.existsSync(config.sslCaPath)) {
    ssl.ca = fs.readFileSync(config.sslCaPath, "utf8");
  }

  return ssl;
}

/**
 * Detects engine kind from MySQL/MariaDB `SELECT VERSION()` output.
 */
function detectEngineFromVersion(versionString, configuredEngine) {
  if (configuredEngine && configuredEngine !== "auto") {
    return configuredEngine;
  }
  const v = String(versionString || "").toLowerCase();
  if (v.includes("mariadb")) return "rds-mariadb";
  if (v.includes("aurora")) return "aurora-mysql";
  if (v.length > 0) return "rds-mysql";
  return "unknown";
}

/**
 * Manages mysql2 connection pool for AWS Aurora (MySQL) and RDS (MariaDB / MySQL)
 * with automatic 12-minute silent IAM token refresh and sandbox simulation support.
 */
class AuroraRdsPoolManager {
  constructor(config = loadDbConfig()) {
    this.config = config;
    this.pool = null;
    this.tlsEnabled = false;
    this.caLoaded = false;

    this.tokenManager = new IamTokenManager({
      hostname: config.auroraHost,
      port: config.auroraPort,
      username: config.auroraUser,
      region: config.region,
      roleArn: config.roleArn,
      authMode: config.authMode,
      onRefresh: async (newToken) => {
        if (this.config.authMode === "iam" && this.pool) {
          await this._rotateIamPool(newToken);
        }
      },
    });
  }

  async initialize() {
    if (this.config.authMode === "awslabs_mysql") {
      // Handled by AwslabsMysqlBridge
      return;
    }

    // Generate & validate initial SigV4 IAM token (for both 'iam' and 'sandbox_sim')
    const token = await this.tokenManager.refreshToken();
    this.tokenManager.startSilentRefresh();

    if (this.config.authMode === "iam") {
      this.pool = this._createIamPool(token);
      console.log(
        `[aurora-rds-mcp] Initialized IAM pool -> ${this.config.auroraHost}:${this.config.auroraPort}/${this.config.auroraDatabase} (TLS: enabled, CA loaded: ${this.caLoaded})`
      );
    } else if (this.config.authMode === "sandbox_sim") {
      this.pool = this._createSandboxPool();
      console.log(
        `[aurora-rds-mcp] Initialized sandbox_sim pool -> ${this.config.sandboxHost}:${this.config.sandboxPort}/${this.config.sandboxDatabase} (SigV4 IAM token verified locally, $0 AWS cost)`
      );
    } else {
      throw new Error(
        `Unsupported DB_AUTH_MODE '${this.config.authMode}'. Expected 'iam', 'awslabs_mysql', or 'sandbox_sim'.`
      );
    }
  }

  _createIamPool(token) {
    const ssl = buildTlsOptions(this.config);
    this.tlsEnabled = true;
    this.caLoaded = Boolean(ssl.ca);

    const self = this;
    return mysql.createPool({
      host: this.config.auroraHost,
      port: this.config.auroraPort,
      user: this.config.auroraUser,
      password: token,
      database: this.config.auroraDatabase,
      ssl,
      authPlugins: {
        mysql_clear_password: () => () => {
          const latest = self.tokenManager.currentToken || token;
          return Buffer.from(`${latest}\0`);
        },
      },
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }

  _createSandboxPool() {
    this.tlsEnabled = false;
    this.caLoaded = false;

    return mysql.createPool({
      host: this.config.sandboxHost,
      port: this.config.sandboxPort,
      user: this.config.sandboxUser,
      password: this.config.sandboxPassword,
      database: this.config.sandboxDatabase,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      queueLimit: 0,
    });
  }

  async _rotateIamPool(newToken) {
    const oldPool = this.pool;
    this.pool = this._createIamPool(newToken);
    console.log(
      `[aurora-rds-mcp] Silently rotated IAM connection pool (refresh #${this.tokenManager.refreshCount})`
    );
    if (oldPool) {
      oldPool.end().catch((err) => {
        console.error("[aurora-rds-mcp] Error closing previous pool after rotation:", err.message);
      });
    }
  }

  async ensurePool() {
    if (!this.pool) {
      await this.initialize();
    }
    return this.pool;
  }

  async query(sql, params = []) {
    // Ensure IAM token is fresh before executing query
    await this.tokenManager.getToken();
    const pool = await this.ensurePool();
    return pool.query(sql, params);
  }

  getActiveDatabase() {
    return this.config.authMode === "sandbox_sim"
      ? this.config.sandboxDatabase
      : this.config.auroraDatabase;
  }

  async checkConnectionStatus() {
    let dbConnected = false;
    let serverVersion = null;
    let currentUser = null;
    let dbError = null;

    try {
      await this.tokenManager.getToken();
      const pool = await this.ensurePool();
      const [rows] = await pool.query(
        "SELECT 1 AS ok, VERSION() AS version, CURRENT_USER() AS db_current_user"
      );
      if (Array.isArray(rows) && rows.length > 0) {
        dbConnected = rows[0].ok === 1 || String(rows[0].ok) === "1";
        serverVersion = rows[0].version || null;
        currentUser = rows[0].db_current_user || null;
      }
    } catch (err) {
      dbError = err.message;
    }

    const tokenStatus = this.tokenManager.getStatus();
    const detectedEngine = detectEngineFromVersion(serverVersion, this.config.engine);

    return {
      connected: dbConnected,
      authMode: this.config.authMode,
      engine: detectedEngine,
      configuredEngine: this.config.engine,
      serverVersion,
      currentUser,
      database: this.getActiveDatabase(),
      targetEndpoint:
        this.config.authMode === "sandbox_sim"
          ? `${this.config.sandboxHost}:${this.config.sandboxPort} (simulated IAM target: ${this.config.auroraHost}:${this.config.auroraPort})`
          : `${this.config.auroraHost}:${this.config.auroraPort}`,
      readOnly: this.config.readOnly,
      tls: {
        enabled: this.tlsEnabled,
        caLoaded: this.caLoaded,
        caPath: this.config.sslCaPath,
        rejectUnauthorized: this.config.sslRejectUnauthorized,
      },
      iamAuth: {
        status: tokenStatus.tokenValid ? "active" : "error",
        tokenFormatValid: tokenStatus.tokenFormatValid,
        region: tokenStatus.region,
        username: tokenStatus.username,
        roleArnConfigured: tokenStatus.roleArnConfigured,
        silentRefreshActive: tokenStatus.silentRefreshActive,
        refreshIntervalSeconds: tokenStatus.refreshIntervalSeconds,
        refreshCount: tokenStatus.refreshCount,
        lastRefreshedAt: tokenStatus.lastRefreshedAt,
        expiresAt: tokenStatus.expiresAt,
        remainingSeconds: tokenStatus.remainingSeconds,
        lastError: tokenStatus.lastError,
      },
      dbError,
    };
  }

  async close() {
    this.tokenManager.stop();
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = {
  AuroraRdsPoolManager,
  loadDbConfig,
  buildTlsOptions,
  detectEngineFromVersion,
  DEFAULT_RDS_CA_PATH,
};
