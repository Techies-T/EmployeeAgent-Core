const express = require('express');
const router = express.Router();
const db = require('../db.cjs');

// Cache for Gateway Admin JWT token (keyed by gatewayUrl)
let cachedToken = null;
let cachedGatewayUrl = null;
let tokenExpiresAt = 0;

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
        return res.json({
            connected: true,
            gatewayUrl,
            ...data
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
        return res.json({
            connected: true,
            gatewayUrl,
            ...data
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
