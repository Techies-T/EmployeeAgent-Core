const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const db = require('./db.cjs');
const { decrypt } = require('./crypto.cjs');
const auditDb = require('./auditDb.cjs');
const mcpHarnessService = require('./services/mcpHarnessService.cjs');
const {
    hydrateAllPolicies,
    evaluateRolesMcpGrant,
    inspectMcpToolCallAgainstGrant,
    isWriteToolName
} = require('./services/ztaPdpService.cjs');

// State maps
const serverConnections = new Map(); // serverId -> Connection Object

async function loadHydratedPolicies() {
    try {
        const raw = JSON.parse((await db.getSetting('RBAC_POLICIES')) || '{}');
        const knownIds = Array.from(serverConnections.keys()).map(String);
        return hydrateAllPolicies(raw, knownIds);
    } catch (e) {
        return hydrateAllPolicies({}, []);
    }
}

function extractUserRoles(user) {
    if (!user || !user.role) return ['user'];
    return String(user.role).split(',').map(r => r.trim()).filter(Boolean);
}

/**
 * Loads all MCP servers from the database and initializes them if not already connected.
 */
async function refreshConnections() {
    await mcpHarnessService.initMcpHarness();
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM mcp_servers", [], async (err, rows) => {
            if (err) return reject(err);
            
            for (const row of rows) {
                let clientSecret = row.client_secret;
                if (clientSecret) {
                    try {
                        clientSecret = decrypt(clientSecret);
                    } catch(e) {
                        console.error(`[MCP] Failed to decrypt secret for server ${row.name}`);
                        clientSecret = null;
                    }
                }

                const inferredMode = row.connection_mode || (
                    (row.endpoint_url || '').includes('localhost:8080/api/mcp/')
                        ? 'builtin_local'
                        : (row.token_url && row.client_id)
                            ? 'zta_gateway'
                            : 'direct_public'
                );

                if (!serverConnections.has(row.id)) {
                    const connState = {
                        id: row.id,
                        name: row.name,
                        endpoint_url: row.endpoint_url,
                        token_url: row.token_url,
                        client_id: row.client_id,
                        client_secret: clientSecret,
                        connection_mode: inferredMode,
                        domain_key: row.domain_key || '',
                        mcpClientInstance: null,
                        mcpTransport: null,
                        tokenCache: { accessToken: null, expiresAt: null },
                        tools: []
                    };
                    serverConnections.set(row.id, connState);
                } else {
                    const existing = serverConnections.get(row.id);
                    existing.name = row.name;
                    existing.endpoint_url = row.endpoint_url;
                    existing.token_url = row.token_url;
                    existing.client_id = row.client_id;
                    existing.client_secret = clientSecret;
                    existing.connection_mode = inferredMode;
                    existing.domain_key = row.domain_key || '';
                }
                
                // Ensure connection is established in the background
                try {
                    await ensureConnection(serverConnections.get(row.id));
                } catch (e) {
                    console.error(`[MCP] Failed to connect to MCP Server ${row.name}:`, e.message);
                }
            }
            resolve();
        });
    });
}

/**
 * Fetches an OAuth token using Client Credentials for a specific server
 */
async function getOAuthToken(connState, user = null, req = null, isRefresh = false) {
    if (connState.connection_mode === 'direct_public' || connState.connection_mode === 'builtin_local') {
        return null;
    }
    if (!connState.token_url) {
        return null;
    }
    
    if (!connState.client_id || !connState.client_secret) {
        return null;
    }

    try {
        const response = await fetch(connState.token_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                'grant_type': 'client_credentials',
                'client_id': connState.client_id,
                'client_secret': connState.client_secret,
                'audience': connState.endpoint_url || ''
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Failed to fetch OAuth token: ${response.status} ${errText}`);
        }

        const data = await response.json();
        
        connState.tokenCache.accessToken = data.access_token;
        const expiresIn = data.expires_in || 3600; 
        connState.tokenCache.expiresAt = Date.now() + (expiresIn - 300) * 1000; 

        console.log(`[MCP ${connState.name}] OAuth Token successfully acquired.`);

        // 監査ログを記録
        await auditDb.logEvent({
            userId: user ? user.id : null,
            userEmail: user ? user.email : 'system',
            eventType: 'mcp_token_acquisition',
            action: `Acquire OAuth Token: ${connState.name}`,
            status: 'success',
            req: req,
            details: {
                serverId: connState.id || null,
                serverName: connState.name,
                connectionMode: connState.connection_mode || 'zta_gateway',
                tokenUrl: connState.token_url,
                clientId: connState.client_id,
                isRefresh: isRefresh,
                reason: user ? 'user_request' : 'background_refresh'
            }
        });

        return connState.tokenCache.accessToken;

    } catch (error) {
        console.error(`[MCP ${connState.name}] OAuth Token Acquisition Error:`, error);

        // 失敗ログを記録
        await auditDb.logEvent({
            userId: user ? user.id : null,
            userEmail: user ? user.email : 'system',
            eventType: 'mcp_token_acquisition',
            action: `Acquire OAuth Token: ${connState.name}`,
            status: 'failure',
            req: req,
            details: {
                serverId: connState.id || null,
                serverName: connState.name,
                connectionMode: connState.connection_mode || 'zta_gateway',
                tokenUrl: connState.token_url,
                clientId: connState.client_id,
                isRefresh: isRefresh,
                reason: user ? 'user_request' : 'background_refresh',
                error: error.message || String(error)
            }
        });

        throw error;
    }
}

/**
 * Returns a valid access token for a server
 */
async function getValidToken(connState, user = null, req = null) {
    if (connState.connection_mode === 'direct_public' || connState.connection_mode === 'builtin_local') {
        return null;
    }
    const isRefresh = !!connState.tokenCache.accessToken;
    if (connState.tokenCache.accessToken && connState.tokenCache.expiresAt && Date.now() < connState.tokenCache.expiresAt) {
        return connState.tokenCache.accessToken;
    }
    return await getOAuthToken(connState, user, req, isRefresh);
}

/**
 * Ensures the MCP client is connected for a specific server
 */
async function ensureConnection(connState, user = null, req = null) {
    if (!connState.endpoint_url) {
        throw new Error("Endpoint URL is not configured.");
    }

    const token = await getValidToken(connState, user, req);

    if (!connState.mcpClientInstance || !connState.mcpTransport) {
        const modeLabel = connState.connection_mode || 'zta_gateway';
        console.log(`[MCP ${connState.name}] Connecting to MCP Server at ${connState.endpoint_url} (mode: ${modeLabel})...`);
        
        const sseUrl = new URL(connState.endpoint_url);
        let requestInit = {};

        if (token) {
            sseUrl.searchParams.set('access_token', token);
            requestInit = {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            };
        }

        connState.mcpTransport = new SSEClientTransport(sseUrl, { requestInit });

        connState.mcpClientInstance = new Client(
            {
                name: "macos-ui-client",
                version: "1.0.0"
            },
            {
                capabilities: {}
            }
        );

        await connState.mcpClientInstance.connect(connState.mcpTransport);
        console.log(`[MCP ${connState.name}] Client connected successfully.`);
        
        // Fetch tools to populate routing map
        try {
            const toolsList = await connState.mcpClientInstance.listTools();
            if (toolsList && toolsList.tools) {
                connState.tools = toolsList.tools;
                console.log(`[MCP Router] Server ${connState.name} loaded ${toolsList.tools.length} tools.`);
            }
        } catch (e) {
            console.error(`[MCP ${connState.name}] Failed to list tools:`, e.message);
        }
    } else if (!connState.tools || connState.tools.length === 0) {
        try {
            const toolsList = await connState.mcpClientInstance.listTools();
            if (toolsList && toolsList.tools && toolsList.tools.length > 0) {
                connState.tools = toolsList.tools;
                console.log(`[MCP Router] Server ${connState.name} successfully reloaded ${toolsList.tools.length} tools.`);
            }
        } catch (e) {
            console.warn(`[MCP ${connState.name}] Retry listTools failed, resetting stale connection:`, e.message);
            if (connState.mcpTransport) {
                try { await connState.mcpTransport.close(); } catch(err) {}
                connState.mcpTransport = null;
            }
            connState.mcpClientInstance = null;
            try {
                return await ensureConnection(connState, user, req);
            } catch (retryErr) {
                console.error(`[MCP ${connState.name}] Reconnection attempt failed:`, retryErr.message);
            }
        }
    }

    return connState.mcpClientInstance;
}

/**
 * Classifies an MCP server into a logical domain and category using the dynamic MCP Harness YAML (`mcpHarnessService`).
 */
function classifyServerDomain(conn) {
    return mcpHarnessService.classifyServerByHarness(conn);
}

/**
 * ZTA-compliant PDP check for MCP server access
 * Evaluates whether a user or requested context has permission to access a specific MCP server.
 */
function hasServerAccess(serverId, allowedWidgets = ['*'], user = null, hydratedPolicies = null) {
    const isAdmin = user?.role === 'admin' || (typeof user?.role === 'string' && user.role.split(',').map(r => r.trim()).includes('admin'));
    if (isAdmin) {
        return true;
    }

    // If hydratedPolicies is available and user has roles, check Universal Grant first
    if (hydratedPolicies && user?.role) {
        const roles = extractUserRoles(user);
        const grant = evaluateRolesMcpGrant(hydratedPolicies, roles, serverId);
        if (grant.allowed) return true;
    }

    if (!allowedWidgets || allowedWidgets.length === 0) {
        if (user?.allowed_actions?.includes('action:use_mcp_tools') || user?.allowed_actions?.includes('*')) {
            return true;
        }
        return false;
    }

    if (allowedWidgets.includes('*') || allowedWidgets.includes('mcp:*')) {
        return true;
    }

    const conn = serverConnections.get(serverId);
    const domainInfo = conn ? classifyServerDomain(conn) : null;

    if (domainInfo?.isBuiltInKnowledge) {
        if (allowedWidgets.includes('app:knowledge-base') || allowedWidgets.includes('mcp:knowledge') || allowedWidgets.includes(`mcp:${serverId}`)) {
            return true;
        }
    }

    const explicitMcpPerms = allowedWidgets.filter(w => typeof w === 'string' && w.startsWith('mcp:'));
    if (explicitMcpPerms.length > 0) {
        return explicitMcpPerms.includes(`mcp:${serverId}`) || 
               explicitMcpPerms.includes('mcp:*') ||
               explicitMcpPerms.some(p => p.toLowerCase() === `mcp:${String(serverId).toLowerCase()}`);
    }

    const hasChatWidget = allowedWidgets.includes('app:mcp-chat');
    const hasAction = user?.allowed_actions?.includes('action:use_mcp_tools') || user?.allowed_actions?.includes('*');

    return hasChatWidget || hasAction;
}

/**
 * Calls a tool, routing it to the correct MCP server and enforcing ZTA Universal Permission Grants (operation_level, data_scope, restricted_identifiers)
 */
async function callMcpTool(name, args, allowedWidgets = ['*'], user = null, req = null, prompt = null) {
    if (serverConnections.size === 0) {
        await refreshConnections();
    }

    const hydratedPolicies = await loadHydratedPolicies();
    const userRoles = extractUserRoles(user);

    let targetConnState = null;
    let activeGrant = null;
    let lastDenyReason = null;

    for (const [id, conn] of serverConnections.entries()) {
        if (!hasServerAccess(id, allowedWidgets, user, hydratedPolicies)) continue;
        
        if (conn.tools && conn.tools.some(t => t.name === name)) {
            const grant = evaluateRolesMcpGrant(hydratedPolicies, userRoles, id);
            // Fall back to permissive grant if legacy allowedWidgets allowed access without explicit mcp_scopes
            const effectiveGrant = grant.allowed ? grant : {
                allowed: true,
                operation_level: 'execute',
                data_scope: 'all_company',
                restricted_identifiers: [],
                blocked_tools: [],
                scope_prompt_guard: ''
            };

            const check = inspectMcpToolCallAgainstGrant(effectiveGrant, name, args);
            if (!check.allowed) {
                lastDenyReason = check.reason;
                continue;
            }

            targetConnState = conn;
            activeGrant = effectiveGrant;
            break;
        }
    }

    if (!targetConnState) {
        const userIdentifier = user?.email || (user ? `ID:${user.id}` : 'anonymous');
        const denyReason = lastDenyReason || `Tool '${name}' is not permitted or disabled for this user/role (${userRoles.join(', ')}).`;
        console.warn(`[SECURITY AUDIT] 🚨 ZTA PEP BLOCKED: Tool '${name}' requested by '${userIdentifier}' -> ${denyReason}`);

        await auditDb.logEvent({
            userId: user ? user.id : null,
            userEmail: user ? user.email : null,
            eventType: 'mcp_tool_access_blocked',
            action: `BLOCKED_UNAUTHORIZED_TOOL_ACCESS: ${name}`,
            status: 'blocked',
            req: req,
            details: {
                toolName: name,
                userRoles,
                arguments: args,
                sqlQuery: args?.query || args?.sql || null,
                aiPrompt: prompt,
                reason: denyReason,
                doubleCheckEnforced: true
            }
        });
        throw new Error(`Access denied (ZTA PEP): ${denyReason}`);
    }

    const sqlQuery = args?.query || args?.sql || null;
    if (sqlQuery) {
        console.log(`[MCP DB Query] 🔍 実行クエリ [Server: ${targetConnState.name} | Mode: ${targetConnState.connection_mode} | OpLevel: ${activeGrant?.operation_level} | Tool: ${name}]:\n${sqlQuery}`);
    } else {
        console.log(`[MCP Tool Call] ⚙️ ツール実行 [Server: ${targetConnState.name} | Mode: ${targetConnState.connection_mode} | Tool: ${name}] Args:`, args);
    }

    let isRetry = false;

    const executeWithRetry = async () => {
        try {
            const client = await ensureConnection(targetConnState, user, req);
            const result = await client.callTool({
                name: name,
                arguments: args || {}
            });

            console.log(`[MCP Exec] ✅ Tool '${name}' completed successfully.`);

            await auditDb.logEvent({
                userId: user ? user.id : null,
                userEmail: user ? user.email : null,
                eventType: 'mcp_tool_execution',
                action: `Call MCP Tool: ${name}`,
                status: 'success',
                req: req,
                details: {
                    serverId: targetConnState.id,
                    serverName: targetConnState.name,
                    connectionMode: targetConnState.connection_mode || 'zta_gateway',
                    operationLevel: activeGrant?.operation_level || 'execute',
                    dataScope: activeGrant?.data_scope || 'all_company',
                    toolName: name,
                    arguments: args,
                    sqlQuery: sqlQuery,
                    aiPrompt: prompt
                }
            });

            return result;
        } catch (error) {
            const errMsg = error.message || String(error);
            const isSessionExpired = errMsg.includes("SSE session not found") || 
                                     errMsg.includes("expired") || 
                                     errMsg.includes("ECONNRESET") || 
                                     errMsg.includes("fetch failed") ||
                                     errMsg.includes("closed");

            if (targetConnState.mcpTransport) {
                try { await targetConnState.mcpTransport.close(); } catch(e) {}
                targetConnState.mcpTransport = null;
            }
            targetConnState.mcpClientInstance = null;

            if (!isRetry && isSessionExpired) {
                console.warn(`[MCP ${targetConnState.name}] Session expired or connection lost (${errMsg}). Auto-reconnecting and retrying tool '${name}'...`);
                isRetry = true;
                return await executeWithRetry();
            }

            console.error(`[MCP ${targetConnState.name}] Error calling Tool ${name}:`, error);
            
            await auditDb.logEvent({
                userId: user ? user.id : null,
                userEmail: user ? user.email : null,
                eventType: 'mcp_tool_execution',
                action: `Call MCP Tool: ${name}`,
                status: 'failure',
                req: req,
                details: {
                    serverId: targetConnState.id,
                    serverName: targetConnState.name,
                    connectionMode: targetConnState.connection_mode || 'zta_gateway',
                    toolName: name,
                    arguments: args,
                    aiPrompt: prompt,
                    error: errMsg
                }
            });

            throw error;
        }
    };

    return await executeWithRetry();
}

/**
 * Disconnects a specific server (e.g. when deleted or updated via API)
 */
function disconnectServer(serverId) {
    const connState = serverConnections.get(serverId);
    if (connState) {
        if (connState.mcpTransport) {
            try { connState.mcpTransport.close(); } catch(e) {}
        }
        serverConnections.delete(serverId);
    }
}

/**
 * Gets all tools from all connected MCP servers formatted for Gemini functionDeclarations,
 * dynamically filtering out write/destructive tools when the user's grant for a server is `read_only`.
 */
async function getAllMcpToolsForGemini(allowedWidgets = ['*'], user = null) {
    if (serverConnections.size === 0) {
        await refreshConnections();
    }
    
    const hydratedPolicies = await loadHydratedPolicies();
    const userRoles = extractUserRoles(user);

    const functionDeclarations = [];
    const addedToolNames = new Set();
    
    for (const [id, conn] of serverConnections.entries()) {
        if (!hasServerAccess(id, allowedWidgets, user, hydratedPolicies)) {
            continue;
        }

        const grant = evaluateRolesMcpGrant(hydratedPolicies, userRoles, id);
        const effectiveOpLevel = grant.allowed ? grant.operation_level : 'execute';
        const blockedTools = grant.allowed ? (grant.blocked_tools || []) : [];

        if (!conn.tools || conn.tools.length === 0 || !conn.mcpClientInstance) {
            try {
                await ensureConnection(conn);
            } catch (e) {
                console.warn(`[MCP Router] Auto-heal tools fetch failed for server ${conn.name}:`, e.message);
            }
        }

        const { domain, category, routingInstruction } = classifyServerDomain(conn);

        if (conn.tools) {
            for (const tool of conn.tools) {
                // Enforce ZTA Universal Grant at tool-discovery time: hide write/destructive tools if read_only
                if (effectiveOpLevel === 'read_only' && isWriteToolName(tool.name)) {
                    continue;
                }
                if (blockedTools.some(bt => bt.toLowerCase() === tool.name.toLowerCase())) {
                    continue;
                }

                const safeName = tool.name.replace(/[^a-zA-Z0-9_]/g, '_');
                
                if (addedToolNames.has(safeName)) {
                    continue;
                }
                addedToolNames.add(safeName);

                const rawDesc = tool.description || `MCP Tool: ${tool.name}`;
                const scopeNote = grant.scope_prompt_guard ? ` [スコープ制約: ${grant.scope_prompt_guard}]` : '';
                const enrichedDesc = `[MCP Server: ${conn.name} | カテゴリ: ${category} | 権限: ${effectiveOpLevel}] ${rawDesc}${scopeNote}`;

                const funcDecl = {
                    name: safeName,
                    description: enrichedDesc,
                    serverId: conn.id,
                    serverName: conn.name,
                    connectionMode: conn.connection_mode || 'zta_gateway',
                    domain: domain,
                    category: category,
                    routingInstruction: routingInstruction || '',
                    operationLevel: effectiveOpLevel,
                    dataScope: grant.data_scope || 'all_company',
                    restrictedIdentifiers: grant.restricted_identifiers || [],
                    scopePromptGuard: grant.scope_prompt_guard || ''
                };
                
                if (tool.inputSchema) {
                    const properties = {};
                    const required = [];
                    
                    if (tool.inputSchema.properties) {
                        for (const [key, value] of Object.entries(tool.inputSchema.properties)) {
                            let typeStr = 'string';
                            if (value.type === 'integer' || value.type === 'number') typeStr = 'number';
                            if (value.type === 'boolean') typeStr = 'boolean';
                            if (value.type === 'array') typeStr = 'array';
                            if (value.type === 'object') typeStr = 'object';
                            
                            properties[key] = {
                                type: typeStr,
                                description: value.description || ''
                            };
                        }
                    }
                    if (Array.isArray(tool.inputSchema.required)) {
                        required.push(...tool.inputSchema.required);
                    }
                    
                    funcDecl.parameters = {
                        type: "object",
                        properties: Object.keys(properties).length > 0 ? properties : undefined,
                        required: required.length > 0 ? required : undefined
                    };
                }
                functionDeclarations.push(funcDecl);
            }
        }
    }
    
    return functionDeclarations;
}

/**
 * Tests an MCP connection without saving to the database
 */
async function testMcpConnection(config, user = null, req = null) {
    const { endpoint_url, token_url, client_id, client_secret, connection_mode } = config;
    
    if (!endpoint_url) {
        return { success: false, error: "Endpoint URL is required." };
    }

    const mode = connection_mode || ((token_url && client_id) ? 'zta_gateway' : 'direct_public');

    const tempState = {
        name: 'TestConnection',
        endpoint_url,
        token_url,
        client_id,
        client_secret,
        connection_mode: mode,
        tokenCache: { accessToken: null, expiresAt: null }
    };

    let mcpTransport = null;
    let mcpClientInstance = null;

    try {
        let token = null;
        if (mode === 'zta_gateway' && token_url && client_id && client_secret) {
            token = await getOAuthToken(tempState, user, req, false);
        }

        const sseUrl = new URL(endpoint_url);
        let requestInit = {};

        if (token) {
            sseUrl.searchParams.set('access_token', token);
            requestInit = {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            };
        }

        mcpTransport = new SSEClientTransport(sseUrl, { requestInit });
        mcpClientInstance = new Client({ name: "macos-ui-test", version: "1.0.0" }, { capabilities: {} });

        await mcpClientInstance.connect(mcpTransport);
        
        const toolsList = await mcpClientInstance.listTools();
        const toolNames = toolsList?.tools?.map(t => t.name) || [];
        const toolCount = toolNames.length;

        await auditDb.logEvent({
            userId: user ? user.id : null,
            userEmail: user ? user.email : null,
            eventType: 'mcp_connection_test',
            action: `Test MCP Connection (${mode}): ${endpoint_url}`,
            status: 'success',
            req: req,
            details: { endpointUrl: endpoint_url, connectionMode: mode, tokenUrl: token_url, toolCount, tools: toolNames }
        });

        return { success: true, connectionMode: mode, toolCount, tools: toolNames };

    } catch (error) {
        await auditDb.logEvent({
            userId: user ? user.id : null,
            userEmail: user ? user.email : null,
            eventType: 'mcp_connection_test',
            action: `Test MCP Connection (${mode}): ${endpoint_url}`,
            status: 'failure',
            req: req,
            details: { endpointUrl: endpoint_url, connectionMode: mode, tokenUrl: token_url, error: error.message || String(error) }
        });

        return { success: false, error: error.message || String(error) };
    } finally {
        if (mcpTransport) {
            try { await mcpTransport.close(); } catch(e) {}
        }
    }
}

/**
 * Returns lightweight metadata of all accessible MCP servers and tools for the client.
 */
async function getMcpMetadata(allowedWidgets = ['*'], user = null) {
    if (serverConnections.size === 0) {
        await refreshConnections();
    }

    const hydratedPolicies = await loadHydratedPolicies();
    const userRoles = extractUserRoles(user);
    const serversMeta = [];

    for (const [id, conn] of serverConnections.entries()) {
        if (!hasServerAccess(id, allowedWidgets, user, hydratedPolicies)) {
            continue;
        }

        const grant = evaluateRolesMcpGrant(hydratedPolicies, userRoles, id);
        const effectiveOpLevel = grant.allowed ? grant.operation_level : 'execute';
        const blockedTools = grant.allowed ? (grant.blocked_tools || []) : [];

        if (!conn.tools || conn.tools.length === 0 || !conn.mcpClientInstance) {
            try {
                await ensureConnection(conn);
            } catch (e) {
                console.warn(`[MCP Meta] Auto-heal tools fetch failed for server ${conn.name}:`, e.message);
            }
        }

        const { domain, icon, category } = classifyServerDomain(conn);

        const toolsMeta = (conn.tools || [])
            .filter(t => !(effectiveOpLevel === 'read_only' && isWriteToolName(t.name)))
            .filter(t => !blockedTools.some(bt => bt.toLowerCase() === t.name.toLowerCase()))
            .map(t => ({
                name: t.name,
                description: t.description || '',
                parameters: t.inputSchema ? Object.keys(t.inputSchema.properties || {}) : []
            }));

        serversMeta.push({
            id: conn.id,
            name: conn.name,
            connection_mode: conn.connection_mode || 'zta_gateway',
            domain_key: conn.domain_key || domain,
            domain,
            icon,
            category,
            operation_level: effectiveOpLevel,
            data_scope: grant.data_scope || 'all_company',
            restricted_identifiers: grant.restricted_identifiers || [],
            scope_prompt_guard: grant.scope_prompt_guard || '',
            toolCount: toolsMeta.length,
            tools: toolsMeta
        });
    }

    return {
        servers: serversMeta,
        totalServers: serversMeta.length,
        totalTools: serversMeta.reduce((acc, s) => acc + s.toolCount, 0)
    };
}

// Auto-init on load
setTimeout(() => refreshConnections(), 2000);

module.exports = {
    callMcpTool,
    refreshConnections,
    disconnectServer,
    getAllMcpToolsForGemini,
    getMcpMetadata,
    testMcpConnection,
    classifyServerDomain
};
