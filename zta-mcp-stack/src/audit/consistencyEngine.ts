import { CatalogProvider } from "../catalog/index.js";
import { ConsistencyResult, ConsistencyStatus, SqlInspectionResult } from "../types/audit.js";

export interface ConsistencyCheckParams {
  upstreamId: string;
  toolName: string;
  clientRoles: string[];
  sqlInspection?: SqlInspectionResult;
  catalogProvider?: CatalogProvider;
}

/**
 * Validates transaction consistency against declarative YAML catalog definitions.
 * Detects undefined table exploration, write operations on read-only tools, and role violations.
 */
export function checkPolicyConsistency(params: ConsistencyCheckParams): ConsistencyResult {
  const { upstreamId, toolName, clientRoles, sqlInspection, catalogProvider } = params;

  if (!catalogProvider) {
    return {
      is_consistent: true,
      status: "CONSISTENT",
      deviations: [],
    };
  }

  // Find all catalogs matching the target upstream (e.g. target_mcp === "mariadb")
  // Or catalogs with target_tool matching
  const allCatalogs = (catalogProvider as any).items || [];
  const matchedCatalogs = allCatalogs.filter(
    (c: any) =>
      c.target_mcp === upstreamId ||
      c.id === upstreamId ||
      c.target_tool === toolName
  );

  if (matchedCatalogs.length === 0) {
    // If no catalog is defined for this upstream, it is not an error if it's an arbitrary MCP
    return {
      is_consistent: true,
      status: "CONSISTENT",
      deviations: [],
    };
  }

  const deviations: string[] = [];
  let status: ConsistencyStatus = "CONSISTENT";
  let primaryCatalogId: string | undefined = undefined;

  for (const catalog of matchedCatalogs) {
    primaryCatalogId = catalog.id;

    // 1. Role Authorization Check against catalog required_roles
    const isSuperAdmin = clientRoles.includes("admin");
    if (!isSuperAdmin && catalog.required_roles && catalog.required_roles.length > 0) {
      const hasRole = catalog.required_roles.some((r: string) => clientRoles.includes(r));
      if (!hasRole) {
        deviations.push(
          `Client roles [${clientRoles.join(", ")}] lack required roles [${catalog.required_roles.join(", ")}] for catalog '${catalog.id}'`
        );
        status = "ROLE_UNAUTHORIZED";
      }
    }

    // 2. SQL Action Type Consistency
    if (sqlInspection && sqlInspection.is_sql) {
      // If catalog target_tool is read-only (e.g. read_query)
      const isReadOnlyTool = catalog.target_tool === "read_query" || toolName === "read_query";
      if (isReadOnlyTool && (sqlInspection.action_type === "WRITE" || sqlInspection.action_type === "DDL")) {
        deviations.push(
          `Action '${sqlInspection.action_type}' is prohibited on read-only catalog tool '${catalog.target_tool || toolName}'`
        );
        status = "WRITE_ON_READ_ONLY_TOOL";
      }

      // 3. Schema Table Whitelist Consistency
      if (catalog.schema && Array.isArray(catalog.schema.tables)) {
        const allowedTables = catalog.schema.tables.map((t: any) =>
          String(t.name).toLowerCase()
        );

        for (const targetTable of sqlInspection.target_tables) {
          const lowerTable = targetTable.toLowerCase();
          if (!allowedTables.includes(lowerTable)) {
            deviations.push(
              `Target table '${targetTable}' is not declared in catalog '${catalog.id}' schema whitelist`
            );
            status = "UNDEFINED_TABLE_ACCESS";
          }
        }
      }
    }
  }

  return {
    catalog_id: primaryCatalogId,
    is_consistent: deviations.length === 0,
    status: deviations.length === 0 ? "CONSISTENT" : status,
    deviations,
  };
}
