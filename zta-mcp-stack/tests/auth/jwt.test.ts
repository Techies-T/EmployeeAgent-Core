import { test, describe } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { verifyToken, extractBearerToken } from "../../src/auth/jwt.js";
import { GatewayConfig } from "../../src/types/index.js";

describe("OAuth 2.1 JWT Verification", () => {
  const testSecret = "test-secret-key-12345678901234567890";
  const mockConfig: GatewayConfig = {
    version: "1.0",
    server: { port: 8080 },
    secrets: { provider: "local" },
    upstreams: [],
  };

  test("successfully verifies valid JWT and extracts roles", () => {
    const token = jwt.sign(
      {
        sub: "agent-007",
        roles: ["analyst", "viewer"],
      },
      testSecret,
      { expiresIn: "1h" }
    );

    const authContext = verifyToken(token, mockConfig, testSecret);
    assert.equal(authContext.clientId, "agent-007");
    assert.deepEqual(authContext.roles, ["analyst", "viewer"]);
  });

  test("rejects expired token", () => {
    const expiredToken = jwt.sign(
      {
        sub: "agent-007",
        roles: ["analyst"],
      },
      testSecret,
      { expiresIn: "-1s" }
    );

    assert.throws(
      () => verifyToken(expiredToken, mockConfig, testSecret),
      /jwt expired/
    );
  });

  test("extracts Bearer token from authorization header correctly", () => {
    assert.equal(extractBearerToken("Bearer token-abc-123"), "token-abc-123");
    assert.equal(extractBearerToken("bearer token-xyz-789"), "token-xyz-789");
    assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
    assert.equal(extractBearerToken(undefined), null);
  });
});
