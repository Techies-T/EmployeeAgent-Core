import fs from "node:fs";
import yaml from "yaml";
import { CatalogDefinitions, CatalogItem, ToolDefinition } from "../types/index.js";

/**
 * CatalogProvider manages YAML-defined metadata for enterprise databases and GenUI templates.
 */
export class CatalogProvider {
  private items: CatalogItem[] = [];
  private definitionsFilePath?: string;

  constructor(filePath?: string) {
    if (filePath) {
      this.load(filePath);
    }
  }

  /**
   * Loads catalog definitions from a YAML file.
   */
  public load(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Catalog definitions file not found at: ${filePath}`);
    }

    this.definitionsFilePath = filePath;
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.parse(content) as CatalogDefinitions;

    if (!parsed || !Array.isArray(parsed.catalogs)) {
      throw new Error("Invalid catalog definitions format: 'catalogs' array is required.");
    }

    this.items = parsed.catalogs;
    console.log(`[CatalogProvider] Loaded ${this.items.length} catalog items from ${filePath}`);
  }

  /**
   * Reloads definitions from the loaded file path (Hot Reload).
   */
  public reload(): void {
    if (this.definitionsFilePath) {
      this.load(this.definitionsFilePath);
    }
  }

  /**
   * Returns all catalog items accessible by the given client roles (Context Masking).
   */
  public listCatalog(roles: string[] = []): Array<Omit<CatalogItem, "schema" | "gen_ui">> {
    const isSuperAdmin = roles.includes("admin");

    return this.items
      .filter((item) => {
        if (isSuperAdmin) return true;
        if (!item.required_roles || item.required_roles.length === 0) return true;
        return item.required_roles.some((r) => roles.includes(r));
      })
      .map(({ id, name, description, target_mcp, target_tool, required_roles }) => ({
        id,
        name,
        description,
        target_mcp,
        target_tool,
        required_roles,
      }));
  }

  /**
   * Returns detailed schema and GenUI configuration for a specific service.
   */
  public getCatalogDetail(serviceId: string, roles: string[] = []): CatalogItem {
    const item = this.items.find((i) => i.id === serviceId);
    if (!item) {
      throw new Error(`Catalog service '${serviceId}' not found.`);
    }

    const isSuperAdmin = roles.includes("admin");
    if (!isSuperAdmin && item.required_roles && item.required_roles.length > 0) {
      const hasPermission = item.required_roles.some((r) => roles.includes(r));
      if (!hasPermission) {
        throw new Error(`Execution denied: Access to catalog '${serviceId}' is forbidden by ZTA policy.`);
      }
    }

    return item;
  }

  /**
   * Returns MCP tool definitions for the Meta-Catalog.
   */
  public getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "list_catalog",
        description: "List all enterprise database catalogs and services accessible by your current role.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_catalog_detail",
        description: "Get detailed database schema (tables, columns, sample queries) and recommended GenUI dashboard layout specification for a specific catalog service.",
        inputSchema: {
          type: "object",
          properties: {
            service_id: {
              type: "string",
              description: "The unique ID of the catalog service (e.g. 'npb_baseball_analytics').",
            },
          },
          required: ["service_id"],
        },
      },
    ];
  }
}
