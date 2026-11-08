import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LocalSecretProvider } from "../../src/secrets/local.js";

describe("LocalSecretProvider", () => {
  test("retrieves secrets from dictionary options", async () => {
    const provider = new LocalSecretProvider({
      secretsMap: {
        DB_PASSWORD: "super-secret-password-123",
      },
    });
    await provider.initialize();

    const value = await provider.getSecret("DB_PASSWORD");
    assert.equal(value, "super-secret-password-123");
  });

  test("retrieves secrets from environment variables", async () => {
    process.env.TEST_GATEWAY_SECRET = "env-secret-val";
    const provider = new LocalSecretProvider();
    await provider.initialize();

    const value = await provider.getSecret("TEST_GATEWAY_SECRET");
    assert.equal(value, "env-secret-val");
    delete process.env.TEST_GATEWAY_SECRET;
  });

  test("throws error when secret does not exist", async () => {
    const provider = new LocalSecretProvider();
    await provider.initialize();

    await assert.rejects(
      async () => {
        await provider.getSecret("NON_EXISTENT_KEY");
      },
      /not found in LocalSecretProvider/
    );
  });

  test("provides a valid 32-byte encryption key buffer", async () => {
    const provider = new LocalSecretProvider();
    await provider.initialize();

    const keyBuf = await provider.getEncryptionKey("master");
    assert.equal(Buffer.isBuffer(keyBuf), true);
    assert.equal(keyBuf.length, 32);
  });
});
