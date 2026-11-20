"use strict";

const { Signer } = require("@aws-sdk/rds-signer");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");

const TOKEN_TTL_MS = 15 * 60 * 1000; // AWS RDS/Aurora IAM token validity: 15 minutes (900s)
const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 1000; // Silent refresh every 12 minutes before expiry
const EXPIRY_SAFETY_BUFFER_MS = 60 * 1000; // Force refresh if < 60s remaining

const SANDBOX_SIM_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7SANDBOX",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

/**
 * Validates that a generated RDS IAM authentication token conforms to
 * AWS SigV4 presigned RDS connect token format.
 *
 * @param {string} token
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateIamTokenFormat(token) {
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, missing: ["non-empty token"] };
  }

  const missing = [];
  if (/^https?:\/\//i.test(token)) {
    missing.push("no-protocol-prefix");
  }

  const requiredMarkers = [
    "Action=connect",
    "DBUser=",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256",
    "X-Amz-Credential=",
    "X-Amz-Date=",
    "X-Amz-Expires=900",
    "X-Amz-SignedHeaders=host",
    "X-Amz-Signature=",
  ];

  for (const marker of requiredMarkers) {
    if (!token.includes(marker)) {
      missing.push(marker);
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Manages AWS Aurora/RDS IAM SigV4 authentication tokens with
 * 12-minute background silent refresh and optional STS AssumeRole support.
 */
class IamTokenManager {
  /**
   * @param {object} config
   * @param {string} config.hostname
   * @param {number} config.port
   * @param {string} config.username
   * @param {string} config.region
   * @param {string} [config.roleArn]
   * @param {string} [config.authMode] - 'iam' | 'sandbox_sim' | 'awslabs_mysql'
   * @param {number} [config.refreshIntervalMs]
   * @param {object} [config.credentials] - Optional explicit AWS credentials or provider
   * @param {Function} [config.onRefresh] - Callback invoked with (newToken, meta) on each refresh
   */
  constructor(config = {}) {
    this.hostname = config.hostname || "localhost";
    this.port = Number(config.port || 3306);
    this.username = config.username || "iam_readonly";
    this.region = config.region || "ap-northeast-1";
    this.roleArn = config.roleArn || "";
    this.authMode = config.authMode || "iam";
    this.refreshIntervalMs = Number(
      config.refreshIntervalMs ||
        process.env.IAM_TOKEN_REFRESH_INTERVAL_MS ||
        DEFAULT_REFRESH_INTERVAL_MS
    );
    this.explicitCredentials = config.credentials || null;
    this.onRefresh = typeof config.onRefresh === "function" ? config.onRefresh : null;

    this.currentToken = null;
    this.lastRefreshedAt = null;
    this.expiresAt = null;
    this.refreshCount = 0;
    this.lastError = null;
    this.tokenFormatCheck = { valid: false, missing: ["not-generated-yet"] };

    this._refreshTimer = null;
    this._inFlightRefresh = null;
    this._stsCache = null;
  }

  /**
   * Resolves AWS credentials for SigV4 signing:
   * 1. Explicit credentials (e.g. unit tests)
   * 2. STS AssumeRole if roleArn is configured
   * 3. Sandbox synthetic credentials in sandbox_sim mode when no AWS env creds exist
   * 4. Default AWS SDK credential provider chain (EC2 IAM Role / ECS / IRSA / env)
   */
  _buildCredentialsProvider() {
    if (this.explicitCredentials) {
      return this.explicitCredentials;
    }

    if (this.roleArn) {
      return async () => {
        const now = Date.now();
        if (
          this._stsCache &&
          this._stsCache.expiration &&
          this._stsCache.expiration.getTime() - now > 5 * 60 * 1000
        ) {
          return this._stsCache;
        }

        const sts = new STSClient({ region: this.region });
        const resp = await sts.send(
          new AssumeRoleCommand({
            RoleArn: this.roleArn,
            RoleSessionName: `aurora-rds-mcp-${Date.now()}`,
            DurationSeconds: 3600,
          })
        );

        const c = resp.Credentials;
        if (!c || !c.AccessKeyId || !c.SecretAccessKey) {
          throw new Error("STS AssumeRole returned incomplete credentials.");
        }

        this._stsCache = {
          accessKeyId: c.AccessKeyId,
          secretAccessKey: c.SecretAccessKey,
          sessionToken: c.SessionToken,
          expiration: c.Expiration ? new Date(c.Expiration) : new Date(now + 3600 * 1000),
        };
        return this._stsCache;
      };
    }

    if (
      this.authMode === "sandbox_sim" &&
      !process.env.AWS_ACCESS_KEY_ID &&
      !process.env.AWS_PROFILE &&
      !process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    ) {
      return SANDBOX_SIM_CREDENTIALS;
    }

    // Undefined -> let @aws-sdk/rds-signer use the standard default provider chain
    // (EC2 IMDSv2 IAM Role, ECS Task Role, IRSA, shared credentials, env vars)
    return undefined;
  }

  /**
   * Generates a fresh 15-minute SigV4 IAM authentication token via @aws-sdk/rds-signer.
   *
   * @returns {Promise<string>}
   */
  async refreshToken() {
    if (this._inFlightRefresh) {
      return this._inFlightRefresh;
    }

    this._inFlightRefresh = (async () => {
      try {
        const signerConfig = {
          hostname: this.hostname,
          port: this.port,
          username: this.username,
          region: this.region,
        };

        const creds = this._buildCredentialsProvider();
        if (creds) {
          signerConfig.credentials = creds;
        }

        const signer = new Signer(signerConfig);
        const token = await signer.getAuthToken();
        const formatCheck = validateIamTokenFormat(token);

        if (!formatCheck.valid) {
          throw new Error(
            `Generated IAM token failed format validation. Missing: ${formatCheck.missing.join(", ")}`
          );
        }

        const now = Date.now();
        this.currentToken = token;
        this.lastRefreshedAt = now;
        this.expiresAt = now + TOKEN_TTL_MS;
        this.refreshCount += 1;
        this.lastError = null;
        this.tokenFormatCheck = formatCheck;

        if (this.onRefresh) {
          try {
            await this.onRefresh(token, this.getStatus());
          } catch (cbErr) {
            console.error("[IamTokenManager] onRefresh callback error:", cbErr.message);
          }
        }

        return token;
      } catch (err) {
        this.lastError = err.message;
        throw err;
      } finally {
        this._inFlightRefresh = null;
      }
    })();

    return this._inFlightRefresh;
  }

  /**
   * Returns a valid IAM token, refreshing immediately if absent or close to expiry.
   *
   * @returns {Promise<string>}
   */
  async getToken() {
    const now = Date.now();
    if (
      !this.currentToken ||
      !this.expiresAt ||
      this.expiresAt - now <= EXPIRY_SAFETY_BUFFER_MS
    ) {
      return this.refreshToken();
    }
    return this.currentToken;
  }

  /**
   * Starts periodic background silent refresh (default: every 12 minutes).
   */
  startSilentRefresh() {
    if (this._refreshTimer) {
      return;
    }

    this._refreshTimer = setInterval(() => {
      this.refreshToken().catch((err) => {
        console.error("[IamTokenManager] Background silent refresh failed:", err.message);
      });
    }, this.refreshIntervalMs);

    if (typeof this._refreshTimer.unref === "function") {
      this._refreshTimer.unref();
    }
  }

  /**
   * Stops background silent refresh timer.
   */
  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Returns sanitized token status (never exposes the raw signature/token).
   */
  getStatus() {
    const now = Date.now();
    const remainingMs = this.expiresAt ? Math.max(0, this.expiresAt - now) : 0;
    const remainingSeconds = Math.floor(remainingMs / 1000);
    const isValid = Boolean(
      this.currentToken && this.tokenFormatCheck.valid && remainingMs > 0
    );

    return {
      authMode: this.authMode,
      region: this.region,
      hostname: this.hostname,
      port: this.port,
      username: this.username,
      roleArnConfigured: Boolean(this.roleArn),
      tokenValid: isValid,
      tokenFormatValid: this.tokenFormatCheck.valid,
      tokenLength: this.currentToken ? this.currentToken.length : 0,
      refreshCount: this.refreshCount,
      refreshIntervalSeconds: Math.floor(this.refreshIntervalMs / 1000),
      silentRefreshActive: Boolean(this._refreshTimer),
      lastRefreshedAt: this.lastRefreshedAt
        ? new Date(this.lastRefreshedAt).toISOString()
        : null,
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      remainingSeconds,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  IamTokenManager,
  validateIamTokenFormat,
  TOKEN_TTL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  SANDBOX_SIM_CREDENTIALS,
};
