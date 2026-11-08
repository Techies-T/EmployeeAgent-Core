import fs from "node:fs";
import crypto from "node:crypto";
import { ISecretProvider, SecretFetchOptions } from "./types.js";

export interface LocalProviderOptions {
  masterKeyFile?: string;
  secretsMap?: Record<string, string>;
}

/**
 * Local Secret Provider:
 * Resolves secrets from environment variables, in-memory dictionary, or local AES key file.
 */
export class LocalSecretProvider implements ISecretProvider {
  private masterKeyFile?: string;
  private inMemorySecrets: Record<string, string>;
  private masterKeyBuffer?: Buffer;

  constructor(options: LocalProviderOptions = {}) {
    this.masterKeyFile = options.masterKeyFile;
    this.inMemorySecrets = options.secretsMap || {};
  }

  async initialize(): Promise<void> {
    if (this.masterKeyFile && fs.existsSync(this.masterKeyFile)) {
      const keyHex = fs.readFileSync(this.masterKeyFile, "utf-8").trim();
      this.masterKeyBuffer = Buffer.from(keyHex, "hex");
      if (this.masterKeyBuffer.length !== 32) {
        // Fallback to SHA-256 hash if not 32 bytes hex
        this.masterKeyBuffer = crypto.createHash("sha256").update(keyHex).digest();
      }
    } else {
      // Default dev fallback
      const devSeed = process.env.LOCAL_MASTER_KEY || "zta-gateway-dev-master-seed";
      this.masterKeyBuffer = crypto.createHash("sha256").update(devSeed).digest();
    }
  }

  async getSecret(key: string, _options?: SecretFetchOptions): Promise<string> {
    // 1. Check in-memory secrets map
    if (this.inMemorySecrets[key] !== undefined) {
      return this.inMemorySecrets[key];
    }

    // 2. Check process environment variable
    if (process.env[key] !== undefined) {
      return process.env[key] as string;
    }

    throw new Error(`Secret '${key}' not found in LocalSecretProvider.`);
  }

  async getEncryptionKey(_keyId: string): Promise<Buffer> {
    if (!this.masterKeyBuffer) {
      await this.initialize();
    }
    return this.masterKeyBuffer!;
  }

  getProviderName(): string {
    return "local";
  }
}
