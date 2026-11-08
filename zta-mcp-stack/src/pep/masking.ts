import { ToolDefinition, UpstreamConfig } from "../types/index.js";

/**
 * Calculates the combined set of allowed tools for a set of roles.
 */
export function getAllowedToolsForRoles(
  roles: string[],
  upstream: UpstreamConfig
): { isWildcard: boolean; allowedSet: Set<string> } {
  const allowedSet = new Set<string>();
  let isWildcard = false;

  const roleMappings = upstream.policies.role_mappings;

  for (const role of roles) {
    const mapping = roleMappings[role];
    if (!mapping) continue;

    for (const tool of mapping.allowed_tools) {
      if (tool === "*") {
        isWildcard = true;
        break;
      }
      allowedSet.add(tool);
    }
    if (isWildcard) break;
  }

  return { isWildcard, allowedSet };
}

/**
 * Filters (masks) upstream tools based on authenticated client roles.
 * Unallowed tools are completely stripped from the result.
 */
export function maskTools(
  tools: ToolDefinition[],
  roles: string[],
  upstream: UpstreamConfig
): ToolDefinition[] {
  const { isWildcard, allowedSet } = getAllowedToolsForRoles(roles, upstream);

  // If wildcard is granted for any of user's roles, return all tools untouched
  if (isWildcard) {
    return [...tools];
  }

  // Filter tools to only those explicitly present in allowedSet
  return tools.filter((tool) => allowedSet.has(tool.name));
}

/**
 * Checks if a specific tool invocation (tools/call) is permitted for the given roles.
 */
export function isToolCallAllowed(
  toolName: string,
  roles: string[],
  upstream: UpstreamConfig
): boolean {
  const { isWildcard, allowedSet } = getAllowedToolsForRoles(roles, upstream);
  if (isWildcard) return true;
  return allowedSet.has(toolName);
}
