/**
 * MCP Tool Definition (per MCP Specification 2026-07)
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
}

/**
 * MCP JSON-RPC Request structure
 */
export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, any>;
    [key: string]: any;
  };
}

/**
 * MCP JSON-RPC Response structure
 */
export interface McpResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: {
    tools?: ToolDefinition[];
    content?: Array<{
      type: string;
      text?: string;
      [key: string]: any;
    }>;
    isError?: boolean;
    [key: string]: any;
  };
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Authenticated Client Context
 */
export interface AuthContext {
  clientId: string;
  roles: string[];
  scopes?: string[];
  issuedAt?: number;
  expiresAt?: number;
}

/**
 * Policy Enforcement Point Decision Result
 */
export interface PepDecision {
  allowed: boolean;
  reason?: string;
  ruleViolated?: string;
  details?: Record<string, any>;
}

/**
 * SQL Firewall Configuration per Upstream
 */
export interface FirewallConfig {
  enforce_sql_check?: boolean;
  restricted_roles?: string[];
  allowed_statements?: string[];
  deny_statements?: string[];
  max_limit?: number;
}

/**
 * Role to Tools Policy Mapping
 */
export interface RoleMapping {
  allowed_tools: string[];
}

/**
 * Upstream MCP Server Configuration
 */
export interface UpstreamConfig {
  id: string;
  path: string;
  target: string;
  description?: string;
  policies: {
    role_mappings: Record<string, RoleMapping>;
    firewall?: FirewallConfig;
  };
}

/**
 * Secret Management Configuration
 */
export interface SecretsConfig {
  provider: "local" | "gcp" | "aws" | "github" | "vault";
  local?: {
    master_key_file?: string;
  };
  gcp?: {
    project_id?: string;
  };
  aws?: {
    region?: string;
  };
  vault?: {
    endpoint?: string;
    role_id_env?: string;
    secret_id_env?: string;
  };
}

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  roles: string[];
}

/**
 * Root Gateway Configuration
 */
export interface GatewayConfig {
  version: string;
  server: {
    port: number;
    host?: string;
    request_timeout_ms?: number;
    cors?: {
      origin: string | string[];
      credentials?: boolean;
    };
  };
  auth?: {
    issuer?: string;
    audience?: string;
    jwks_uri?: string;
    local_jwt_secret_env?: string;
    clients?: OAuthClient[];
  };
  secrets: SecretsConfig;
  catalog?: {
    definitions_file?: string;
  };
  upstreams: UpstreamConfig[];
}

/**
 * Catalog Table Schema definition
 */
export interface CatalogTableSchema {
  name: string;
  description?: string;
  primary_key?: string;
  columns?: string;
  relationships?: string[];
}

/**
 * GenUI Specification definition for AI-Native BI
 */
export interface CatalogGenUiConfig {
  recommended_layout?: string;
  framework?: string;
  color_palette?: Record<string, string>;
  components?: Array<Record<string, any>>;
  [key: string]: any;
}

/**
 * Catalog Item definition for Meta-Catalog MCP
 */
export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  target_mcp?: string;
  target_tool?: string;
  required_roles?: string[];
  schema?: {
    tables?: CatalogTableSchema[];
    query_rules?: string[];
    recommended_queries?: Array<{ title?: string; sql: string }>;
    [key: string]: any;
  };
  gen_ui?: CatalogGenUiConfig;
}

/**
 * Catalog Definitions Root
 */
export interface CatalogDefinitions {
  version: string;
  catalogs: CatalogItem[];
}

export * from "./audit.js";

