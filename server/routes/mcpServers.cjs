const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { encrypt, decrypt } = require('../crypto.cjs');
const { refreshConnections, disconnectServer, testMcpConnection, classifyServerDomain } = require('../mcpClient.cjs');
const mcpHarnessService = require('../services/mcpHarnessService.cjs');

// Safe auto-migration for connection_mode & domain_key columns
db.all("PRAGMA table_info(mcp_servers)", [], (err, cols) => {
    if (err || !Array.isArray(cols)) return;
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('connection_mode')) {
        db.run("ALTER TABLE mcp_servers ADD COLUMN connection_mode TEXT DEFAULT 'zta_gateway'", () => {});
    }
    if (!colNames.includes('domain_key')) {
        db.run("ALTER TABLE mcp_servers ADD COLUMN domain_key TEXT DEFAULT ''", () => {});
    }
});

// Helper function to enforce ZTA HTTPS compliance for MCP URLs
function validateZtaUrls(endpointUrl, tokenUrl, connectionMode = 'zta_gateway') {
    const checkUrl = (urlStr) => {
        if (!urlStr) return true;
        try {
            const parsed = new URL(urlStr);
            if (parsed.protocol === 'https:') {
                return true;
            }
            const isLocal = parsed.hostname === 'localhost' || 
                            parsed.hostname === '127.0.0.1' || 
                            parsed.hostname === 'host.docker.internal';
            if (isLocal) {
                return true;
            }
            // Allow HTTP for explicit direct_public open data endpoints if needed in dev/test
            if (connectionMode === 'direct_public' && parsed.protocol === 'http:') {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    };

    if (!checkUrl(endpointUrl)) {
        return 'ZTA Security Policy requires HTTPS for MCP endpoints. Non-secure HTTP is only permitted on localhost or explicit Direct Public mode.';
    }
    if (connectionMode === 'zta_gateway' && tokenUrl && !checkUrl(tokenUrl)) {
        return 'ZTA Security Policy requires HTTPS for OAuth token endpoints. Non-secure HTTP is only permitted on localhost.';
    }
    return null;
}

// ============================================================================
// Dynamic MCP Harness (mcp-harness.yaml) GUI Editor & 0-Second Hot-Reload API
// ============================================================================
router.get('/harness', async (req, res) => {
    try {
        await mcpHarnessService.initMcpHarness();
        const yaml = mcpHarnessService.getHarnessYamlText();
        const config = mcpHarnessService.getHarnessConfig();
        res.json({
            yaml,
            yamlText: yaml,
            config,
            parsed: config,
            filePath: mcpHarnessService.HARNESS_FILE_PATH
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load MCP harness configuration' });
    }
});

router.post('/harness', async (req, res) => {
    try {
        const rawYaml = req.body?.yaml ?? req.body?.yamlText;
        if (!rawYaml || typeof rawYaml !== 'string') {
            return res.status(400).json({ error: 'yaml content is required' });
        }
        const saved = await mcpHarnessService.saveAndHotReloadHarness(rawYaml);
        // Trigger background connection & classification refresh (0-second hot reload)
        refreshConnections().catch(err => console.warn('[MCP Harness] Refresh error:', err.message));
        res.json({
            success: true,
            message: 'MCP ハーネス定義 (mcp-harness.yaml) を保存し、ホットリロードを完了しました。',
            yaml: saved.yaml,
            yamlText: saved.yaml,
            config: saved.config,
            parsed: saved.config,
            ...saved
        });
    } catch (e) {
        res.status(400).json({ error: e.message || 'Invalid YAML configuration' });
    }
});

router.post('/harness/reset', async (req, res) => {
    try {
        const resetData = await mcpHarnessService.resetHarnessToDefault();
        refreshConnections().catch(err => console.warn('[MCP Harness] Refresh error:', err.message));
        res.json({
            success: true,
            message: 'MCP ハーネス定義をデフォルト設定に復元しました。',
            ...resetData
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to reset harness' });
    }
});

// POST to test an existing MCP server connection (by ID)
router.post('/:id/test', async (req, res) => {
    const { id } = req.params;
    db.get("SELECT * FROM mcp_servers WHERE id = ?", [id], async (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: 'Server not found' });
        }
        
        let clientSecret = row.client_secret;
        if (clientSecret) {
            try {
                clientSecret = decrypt(clientSecret);
            } catch (e) {
                console.error("Failed to decrypt secret for test:", e);
                clientSecret = null;
            }
        }
        
        const result = await testMcpConnection({
            endpoint_url: row.endpoint_url,
            token_url: row.token_url,
            client_id: row.client_id,
            client_secret: clientSecret,
            connection_mode: row.connection_mode || (row.token_url ? 'zta_gateway' : 'direct_public')
        }, req.user, req);
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    });
});

// POST to test a new or edited MCP server connection
router.post('/test', async (req, res) => {
    const { id, endpoint_url, token_url, client_id, client_secret, connection_mode } = req.body;
    
    if (!endpoint_url) {
        return res.status(400).json({ error: 'Endpoint URL is required' });
    }

    const mode = connection_mode || ((token_url && client_id) ? 'zta_gateway' : 'direct_public');

    const validationError = validateZtaUrls(endpoint_url, token_url, mode);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    let finalSecret = client_secret;

    if (!finalSecret && id && mode === 'zta_gateway') {
        try {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT client_secret FROM mcp_servers WHERE id = ?", [id], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            if (row && row.client_secret) {
                finalSecret = decrypt(row.client_secret);
            }
        } catch (e) {
            console.error("Failed to fetch/decrypt existing secret for test:", e);
        }
    }

    const result = await testMcpConnection({
        endpoint_url,
        token_url: mode === 'direct_public' ? null : token_url,
        client_id: mode === 'direct_public' ? null : client_id,
        client_secret: mode === 'direct_public' ? null : finalSecret,
        connection_mode: mode
    }, req.user, req);

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// GET all MCP servers (client_secret is NOT returned)
router.get('/', (req, res) => {
    db.all("SELECT id, name, endpoint_url, token_url, client_id, connection_mode, domain_key, created_at FROM mcp_servers", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch MCP servers' });
        }
        const enriched = (rows || []).map(row => {
            const inferredMode = row.connection_mode || (
                (row.endpoint_url || '').includes('localhost:8080/api/mcp/')
                    ? 'builtin_local'
                    : (row.token_url && row.client_id)
                        ? 'zta_gateway'
                        : 'direct_public'
            );
            const domainInfo = classifyServerDomain(row);
            return {
                ...row,
                connection_mode: inferredMode,
                domain_key: row.domain_key || domainInfo.domain || 'general',
                domain_icon: domainInfo.icon || '⚡',
                domain_category: domainInfo.category || 'システム・汎用'
            };
        });
        res.json(enriched);
    });
});

// POST a new MCP server
router.post('/', (req, res) => {
    const { name, endpoint_url, token_url, client_id, client_secret, connection_mode, domain_key } = req.body;

    if (!name || !endpoint_url) {
        return res.status(400).json({ error: 'Name and Endpoint URL are required' });
    }

    const mode = connection_mode || ((token_url && client_id) ? 'zta_gateway' : 'direct_public');

    const validationError = validateZtaUrls(endpoint_url, token_url, mode);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    let encryptedSecret = null;
    if (client_secret && mode !== 'direct_public') {
        encryptedSecret = encrypt(client_secret);
    }

    db.run(
        `INSERT INTO mcp_servers (name, endpoint_url, token_url, client_id, client_secret, connection_mode, domain_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            name,
            endpoint_url,
            mode === 'direct_public' ? null : (token_url || null),
            mode === 'direct_public' ? null : (client_id || null),
            encryptedSecret,
            mode,
            domain_key || ''
        ],
        function (err) {
            if (err) {
                console.error("Error creating MCP server:", err);
                return res.status(500).json({ error: 'Failed to create MCP server' });
            }
            refreshConnections().catch(e => console.error("Error refreshing MCP connections:", e));
            res.status(201).json({ id: this.lastID, connection_mode: mode, message: 'MCP server created successfully' });
        }
    );
});

// PUT (update) an existing MCP server
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { name, endpoint_url, token_url, client_id, client_secret, connection_mode, domain_key } = req.body;

    if (!name || !endpoint_url) {
        return res.status(400).json({ error: 'Name and Endpoint URL are required' });
    }

    const mode = connection_mode || ((token_url && client_id) ? 'zta_gateway' : 'direct_public');

    const validationError = validateZtaUrls(endpoint_url, token_url, mode);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    if (client_secret && mode !== 'direct_public') {
        const encryptedSecret = encrypt(client_secret);
        db.run(
            `UPDATE mcp_servers SET name = ?, endpoint_url = ?, token_url = ?, client_id = ?, client_secret = ?, connection_mode = ?, domain_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [name, endpoint_url, token_url || null, client_id || null, encryptedSecret, mode, domain_key || '', id],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to update MCP server' });
                
                disconnectServer(parseInt(id));
                refreshConnections().catch(e => console.error("Error refreshing MCP connections:", e));
                res.json({ message: 'MCP server updated successfully' });
            }
        );
    } else {
        db.run(
            `UPDATE mcp_servers SET name = ?, endpoint_url = ?, token_url = ?, client_id = ?, connection_mode = ?, domain_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [
                name,
                endpoint_url,
                mode === 'direct_public' ? null : (token_url || null),
                mode === 'direct_public' ? null : (client_id || null),
                mode,
                domain_key || '',
                id
            ],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to update MCP server' });
                
                disconnectServer(parseInt(id));
                refreshConnections().catch(e => console.error("Error refreshing MCP connections:", e));
                res.json({ message: 'MCP server updated successfully' });
            }
        );
    }
});

// DELETE an MCP server
router.delete('/:id', (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM mcp_servers WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: 'Failed to delete MCP server' });
        
        disconnectServer(parseInt(id));
        res.json({ message: 'MCP server deleted successfully' });
    });
});

module.exports = router;
