const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const auditDb = require('../auditDb.cjs');

// Cache for Gateway Admin JWT token (keyed by gatewayUrl)
let cachedToken = null;
let cachedGatewayUrl = null;
let tokenExpiresAt = 0;

/**
 * Enrich ZTA Gateway transaction logs with EmployeeAgent end-user identity (user_email, user_id, user_roles)
 * from either _zta_context propagated to Gateway or local security_logs correlation.
 */
async function enrichGatewayLogsWithUserIdentity(gatewayLogs = []) {
    if (!Array.isArray(gatewayLogs) || gatewayLogs.length === 0) return gatewayLogs;

    let localMcpLogs = [];
    let allUsers = [];
    try {
        const rawSecurityLogs = await auditDb.getLogs(1000);
        localMcpLogs = (rawSecurityLogs || [])
            .filter(l => (l.event_type === 'mcp_tool_execution' || l.event_type === 'mcp_tool_access_blocked') && l.user_email)
            .map(l => {
                let parsedDetails = {};
                if (l.details) {
                    try { parsedDetails = typeof l.details === 'string' ? JSON.parse(l.details) : l.details; } catch (e) {}
                }
                const ts = l.created_at ? new Date(l.created_at.endsWith('Z') ? l.created_at : `${l.created_at}Z`).getTime() : 0;
                return {
                    ...l,
                    parsedDetails,
                    ts
                };
            });
    } catch (e) { /* ignore */ }

    try {
        if (typeof db.getAllUsers === 'function') {
            allUsers = await db.getAllUsers() || [];
        }
    } catch (e) { /* ignore */ }

    const fallbackSingleUser = allUsers.length === 1 ? allUsers[0] : (allUsers.find(u => u.role === 'admin' || (u.roles && u.roles.includes('admin'))) || null);

    return gatewayLogs.map(log => {
        if (log.client?.user_email) {
            return log;
        }

        // Check if _zta_context was stored in details.args
        const ctxInDetails = log.details?.args?._zta_context || log.details?._zta_context;
        if (ctxInDetails?.user_email) {
            return {
                ...log,
                client: {
                    ...log.client,
                    user_id: ctxInDetails.user_id || null,
                    user_email: ctxInDetails.user_email,
                    user_name: ctxInDetails.user_name || null,
                    user_roles: ctxInDetails.user_roles || log.client?.roles || []
                }
            };
        }

        // Correlate with local security_logs by tool_name and timestamp proximity (within 30 seconds)
        const gwTs = log.timestamp ? new Date(log.timestamp).getTime() : 0;
        const toolName = log.upstream?.tool_name || '';
        let bestMatch = null;
        let minDiff = Infinity;

        for (const localLog of localMcpLogs) {
            const localTool = localLog.parsedDetails?.toolName || '';
            if (toolName && localTool && localTool !== toolName) continue;
            const diff = Math.abs(gwTs - localLog.ts);
            if (diff < 60000 && diff < minDiff) {
                minDiff = diff;
                bestMatch = localLog;
            }
        }

        if (bestMatch) {
            const matchedUserObj = allUsers.find(u => u.email === bestMatch.user_email || u.id === bestMatch.user_id);
            return {
                ...log,
                client: {
                    ...log.client,
                    user_id: bestMatch.user_id || matchedUserObj?.id || null,
                    user_email: bestMatch.user_email,
                    user_name: matchedUserObj?.name || null,
                    user_roles: bestMatch.parsedDetails?.userRoles || matchedUserObj?.roles || log.client?.roles || []
                }
            };
        }

        if (fallbackSingleUser?.email) {
            return {
                ...log,
                client: {
                    ...log.client,
                    user_id: fallbackSingleUser.id || null,
                    user_email: fallbackSingleUser.email,
                    user_name: fallbackSingleUser.name || null,
                    user_roles: fallbackSingleUser.roles || [fallbackSingleUser.role || 'admin']
                }
            };
        }

        return log;
    });
}

/**
 * Resolve candidate ZTA Gateway URLs dynamically from env, registered MCP servers in DB, and Docker/local defaults
 */
async function getCandidateGatewayUrls() {
    const candidates = [];
    if (process.env.ZTA_GATEWAY_URL) {
        candidates.push(process.env.ZTA_GATEWAY_URL.replace(/\/+$/, ''));
    }

    try {
        if (typeof db.getAllMcpServers === 'function') {
            const servers = await db.getAllMcpServers();
            for (const s of (servers || [])) {
                const rawUrl = s.token_url || s.endpoint_url || '';
                if (rawUrl && (rawUrl.includes(':8085') || rawUrl.includes('zta-mcp-gateway') || rawUrl.includes('/oauth/token'))) {
                    try {
                        const parsed = new URL(rawUrl);
                        if (parsed.port !== '8080' || parsed.hostname !== 'localhost') {
                            candidates.push(parsed.origin);
                        }
                    } catch (e) { /* ignore invalid URL */ }
                }
            }
        }
    } catch (e) {
        // Ignore DB lookup errors and proceed with defaults
    }

    candidates.push('http://host.docker.internal:8085');
    candidates.push('http://172.17.0.1:8085');
    candidates.push('http://zta-mcp-gateway:8080');
    candidates.push('http://localhost:8085');

    return [...new Set(candidates)];
}

/**
 * Helper to obtain a valid JWT token from ZTA-MCP-Gateway using client credentials,
 * automatically probing candidate Gateway URLs when running inside Docker or on host.
 */
async function getGatewayConnection() {
    const now = Date.now();
    if (cachedToken && cachedGatewayUrl && tokenExpiresAt > now + 60000) {
        return { gatewayUrl: cachedGatewayUrl, token: cachedToken };
    }

    const clientId = process.env.ZTA_ADMIN_CLIENT_ID || 'macosui-admin';
    const clientSecret = process.env.ZTA_ADMIN_CLIENT_SECRET || 'admin-secret-2026';
    const candidates = await getCandidateGatewayUrls();
    let lastError = null;

    for (const gatewayUrl of candidates) {
        try {
            const tokenRes = await fetch(`${gatewayUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'client_credentials',
                    client_id: clientId,
                    client_secret: clientSecret
                }),
                signal: AbortSignal.timeout(2500)
            });

            if (!tokenRes.ok) {
                throw new Error(`Failed to authenticate with ZTA Gateway (${gatewayUrl}): ${tokenRes.status}`);
            }

            const data = await tokenRes.json();
            cachedToken = data.access_token;
            cachedGatewayUrl = gatewayUrl;
            tokenExpiresAt = now + ((data.expires_in || 3600) * 1000);
            return { gatewayUrl, token: cachedToken };
        } catch (err) {
            lastError = err;
        }
    }

    cachedToken = null;
    cachedGatewayUrl = null;
    tokenExpiresAt = 0;
    const error = lastError || new Error('No reachable ZTA-MCP-Gateway found');
    error.triedUrls = candidates;
    throw error;
}

/**
 * Middleware: Check if requesting user has admin / manage_system_settings permissions
 */
function requireAdmin(req, res, next) {
    const user = req.user;
    if (!user) {
        return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
    }

    const allowed = user.allowed_actions || [];
    const roles = Array.isArray(user.roles) ? user.roles : [user.role];
    const isSuperAdmin = roles.includes('admin') || allowed.includes('*') || allowed.includes('action:manage_system_settings');

    if (!isSuperAdmin) {
        return res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
    }
    next();
}

/**
 * GET /api/zta/audit/logs
 * Query filtered logs from ZTA-MCP-Gateway
 */
router.get('/logs', requireAdmin, async (req, res) => {
    try {
        const { gatewayUrl, token } = await getGatewayConnection();
        const queryParams = new URLSearchParams(req.query).toString();
        const targetUrl = `${gatewayUrl}/api/v1/audit/logs${queryParams ? `?${queryParams}` : ''}`;

        const gatewayRes = await fetch(targetUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            signal: AbortSignal.timeout(4000)
        });

        if (!gatewayRes.ok) {
            const errText = await gatewayRes.text();
            return res.status(gatewayRes.status).json({
                connected: true,
                gatewayUrl,
                error: 'gateway_error',
                message: errText
            });
        }

        const data = await gatewayRes.json();
        const enrichedLogs = await enrichGatewayLogsWithUserIdentity(data.logs || []);
        return res.json({
            connected: true,
            gatewayUrl,
            ...data,
            logs: enrichedLogs
        });
    } catch (err) {
        // Graceful degradation when Gateway is unreachable
        return res.json({
            connected: false,
            gatewayUrl: (err.triedUrls && err.triedUrls[0]) || 'http://host.docker.internal:8085',
            message: `ZTA-MCP-Gateway is currently unreachable (${err.message})`,
            total: 0,
            logs: []
        });
    }
});

/**
 * GET /api/zta/audit/summary
 * Query summary metrics from ZTA-MCP-Gateway
 */
router.get('/summary', requireAdmin, async (req, res) => {
    try {
        const { gatewayUrl, token } = await getGatewayConnection();
        const targetUrl = `${gatewayUrl}/api/v1/audit/summary`;

        const gatewayRes = await fetch(targetUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            signal: AbortSignal.timeout(4000)
        });

        if (!gatewayRes.ok) {
            const errText = await gatewayRes.text();
            return res.status(gatewayRes.status).json({
                connected: true,
                gatewayUrl,
                error: 'gateway_error',
                message: errText
            });
        }

        const data = await gatewayRes.json();
        const enrichedLogs = await enrichGatewayLogsWithUserIdentity(data.logs || []);
        return res.json({
            connected: true,
            gatewayUrl,
            ...data,
            logs: enrichedLogs
        });
    } catch (err) {
        return res.json({
            connected: false,
            gatewayUrl: (err.triedUrls && err.triedUrls[0]) || 'http://host.docker.internal:8085',
            message: `ZTA-MCP-Gateway is currently unreachable (${err.message})`,
            total_transactions: 0,
            allowed_count: 0,
            blocked_count: 0,
            deviation_count: 0,
            top_tables: [],
            action_breakdown: {},
            client_breakdown: {}
        });
    }
});

module.exports = router;
