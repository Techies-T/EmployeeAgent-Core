export interface SecretFetchOptions {
  version?: string;
  cacheTtlMs?: number;
}

/**
 * Common pluggable secret provider interface (ZTA Compliant)
 */
export interface ISecretProvider {
  /**
   * Initializes connection or credentials
   */
  initialize(): Promise<void>;

  /**
   * Retrieves a secret string (e.g. database password or upstream token)
   */
  getSecret(key: string, options?: SecretFetchOptions): Promise<string>;

  /**
   * Retrieves a cryptographic key buffer (e.g. for AES-256)
   */
  getEncryptionKey(keyId: string): Promise<Buffer>;

  /**
   * Returns the provider identifier ('local' | 'gcp' | 'aws' | 'github' | 'vault')
   */
  getProviderName(): string;
}
