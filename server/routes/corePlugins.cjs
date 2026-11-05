const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const auditDb = require('../auditDb.cjs');
const pluginManager = require('../services/pluginManager.cjs');
const ztaPdpService = require('../services/ztaPdpService.cjs');

function hasAdminOrSettingPerm(user) {
    if (!user) return false;
    const roles = (user.role || '').split(',').map(r => r.trim());
    if (roles.includes('admin')) return true;
    const allowed = user.allowed_actions || [];
    return allowed.includes('*') || allowed.includes('action:manage_system_settings') || allowed.includes('action:manage_roles');
}

// 1. GET /api/core/plugins - インストール済ウィジェット・カタログ・Shared Capability Bus 状態を取得
router.get('/plugins', async (req, res) => {
    try {
        const catalogData = await pluginManager.getFullPluginCatalog();

        // Also fetch current AI routing settings for each widget so AI Hub can display a unified table
        const [
            aiProvider,
            geminiModel,
            claudeModel,
            chatAiProvider,
            mcpAiProvider,
            geminiMcpModel,
            claudeMcpModel,
            ragAiProvider,
            htmlSvgModel,
            researchAiProvider,
            researchModel,
            liveDefaultModel,
            localAiEnabled,
            localAiHost,
            localAiModel
        ] = await Promise.all([
            db.getSetting('AI_PROVIDER'),
            db.getSetting('GEMINI_MODEL'),
            db.getSetting('CLAUDE_MODEL'),
            db.getSetting('CHAT_AI_PROVIDER'),
            db.getSetting('MCP_AI_PROVIDER'),
            db.getSetting('GEMINI_MCP_CHAT_MODEL'),
            db.getSetting('CLAUDE_MCP_CHAT_MODEL'),
            db.getSetting('RAG_AI_PROVIDER'),
            db.getSetting('GEMINI_HTML_SVG_MODEL'),
            db.getSetting('RESEARCH_AI_PROVIDER'),
            db.getSetting('GEMINI_RESEARCH_MODEL'),
            db.getSetting('GEMINI_LIVE_DEFAULT_MODEL'),
            db.getSetting('LOCAL_AI_ENABLED'),
            db.getSetting('LOCAL_AI_HOST'),
            db.getSetting('LOCAL_AI_MODEL')
        ]);

        const defaultProvider = aiProvider || 'gemini';
        const defaultGemini = geminiModel || 'gemini-3.1-flash-lite-preview';
        const defaultClaude = claudeModel || 'claude-sonnet-4-6';
        const defaultLocal = localAiModel || 'gemma4:26b-mlx';

        const aiRoutingState = {
            defaultProvider,
            defaultGeminiModel: defaultGemini,
            defaultClaudeModel: defaultClaude,
            localAiEnabled: localAiEnabled !== 'false',
            localAiHost: localAiHost || 'http://localhost:11434',
            localAiModel: defaultLocal,
            widgets: {
                gemini: {
                    provider: chatAiProvider || defaultProvider,
                    geminiModel: defaultGemini,
                    claudeModel: defaultClaude,
                    localModel: defaultLocal
                },
                'mcp-chat': {
                    provider: mcpAiProvider || defaultProvider,
                    geminiModel: geminiMcpModel || defaultGemini,
                    claudeModel: claudeMcpModel || defaultClaude
                },
                'knowledge-base': {
                    provider: ragAiProvider || (localAiEnabled !== 'false' ? 'local' : defaultProvider),
                    geminiModel: htmlSvgModel || defaultGemini,
                    claudeModel: defaultClaude,
                    localModel: defaultLocal
                },
                'deep-research': {
                    provider: researchAiProvider || defaultProvider,
                    geminiModel: researchModel || defaultGemini,
                    claudeModel: defaultClaude
                },
                'live-concierge': {
                    provider: 'gemini',
                    geminiModel: liveDefaultModel || 'gemini-3.8-live'
                }
            }
        };

        res.json({
            ...catalogData,
            aiRoutingState
        });
    } catch (err) {
        console.error('[CorePlugins] GET /plugins error:', err);
        res.status(500).json({ error: 'プラグイン情報の取得に失敗しました' });
    }
});

// 2. POST /api/core/plugins/install - ウィジェットプラグインの動的インストール / トライアル有効化 / ライセンス適用
router.post('/plugins/install', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: 'ウィジェット管理権限が必要です' });
    }

    const { widgetId, mode = 'install', licenseKey = '', customManifest = null } = req.body;
    if (!widgetId && !customManifest?.id) {
        return res.status(400).json({ error: 'widgetId is required' });
    }

    try {
        const targetId = widgetId || customManifest.id;
        const updatedCatalog = await pluginManager.installWidgetPlugin(targetId, {
            mode,
            licenseKey,
            customManifest
        });

        await auditDb.logEvent({
            userId: req.user?.id || null,
            userEmail: req.user?.email || null,
            eventType: 'plugin_installed',
            action: 'POST /api/core/plugins/install',
            status: 'success',
            req,
            details: { widgetId: targetId, mode }
        });

        res.json({
            success: true,
            message: `ウィジェット「${targetId}」をインストールしました`,
            ...updatedCatalog
        });
    } catch (err) {
        console.error('[CorePlugins] Install error:', err);
        res.status(400).json({ error: err.message || 'ウィジェットのインストールに失敗しました' });
    }
});

// 3. POST /api/core/plugins/uninstall - ウィジェットプラグインのアンインストール
router.post('/plugins/uninstall', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: 'ウィジェット管理権限が必要です' });
    }

    const { widgetId } = req.body;
    if (!widgetId) {
        return res.status(400).json({ error: 'widgetId is required' });
    }

    try {
        const updatedCatalog = await pluginManager.uninstallWidgetPlugin(widgetId);

        await auditDb.logEvent({
            userId: req.user?.id || null,
            userEmail: req.user?.email || null,
            eventType: 'plugin_uninstalled',
            action: 'POST /api/core/plugins/uninstall',
            status: 'success',
            req,
            details: { widgetId }
        });

        res.json({
            success: true,
            message: `ウィジェット「${widgetId}」をアンインストールしました`,
            ...updatedCatalog
        });
    } catch (err) {
        console.error('[CorePlugins] Uninstall error:', err);
        res.status(500).json({ error: err.message || 'アンインストールに失敗しました' });
    }
});

// 4. POST /api/core/plugins/reset-minimum - ミニマム構成（ノーマルチャット＋MCPクライアントのみ）へリセット
router.post('/plugins/reset-minimum', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: 'ウィジェット管理権限が必要です' });
    }

    try {
        const updatedCatalog = await pluginManager.resetToMinimumConfiguration();
        await auditDb.logEvent({
            userId: req.user?.id || null,
            userEmail: req.user?.email || null,
            eventType: 'plugin_reset_minimum',
            action: 'POST /api/core/plugins/reset-minimum',
            status: 'success',
            req,
            details: { installed: ['gemini', 'mcp-chat'] }
        });

        res.json({
            success: true,
            message: 'ミニマム構成（ノーマルチャット＋MCPクライアントのみ）にリセットしました',
            ...updatedCatalog
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. POST /api/core/plugins/generate-license - ライセンスキー発行（提案・検証用）
router.post('/plugins/generate-license', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: '管理権限が必要です' });
    }
    const { widgetId, tenantName = 'Enterprise Client', widgets, validDays = 365 } = req.body;
    const targetWidgets = Array.isArray(widgets) ? widgets : (widgetId ? [widgetId] : ['*']);
    const expiresAt = new Date(Date.now() + Number(validDays) * 24 * 3600 * 1000).toISOString();
    const licenseKey = pluginManager.generateWidgetLicenseKey({ tenantName, widgets: targetWidgets, expiresAt });
    res.json({ licenseKey, tenantName, widgets: targetWidgets, expiresAt });
});

// 6. POST /api/core/ai-routing - ウィジェット別AIモデルルーティングの保存
router.post('/ai-routing', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: '設定変更権限が必要です' });
    }

    try {
        const {
            widgetId,
            provider,
            model,
            defaultProvider,
            defaultGeminiModel,
            defaultClaudeModel,
            widgets = {}
        } = req.body;

        if (widgetId) {
            widgets[widgetId] = {
                provider,
                geminiModel: provider === 'gemini' ? model : undefined,
                claudeModel: provider === 'claude' ? model : undefined,
                localModel: provider === 'local' ? model : undefined
            };
        }

        if (defaultProvider) await db.setSetting('AI_PROVIDER', defaultProvider);
        if (defaultGeminiModel) await db.setSetting('GEMINI_MODEL', defaultGeminiModel.replace(/^models\//, ''));
        if (defaultClaudeModel) await db.setSetting('CLAUDE_MODEL', defaultClaudeModel);

        if (widgets.gemini) {
            if (widgets.gemini.provider) await db.setSetting('CHAT_AI_PROVIDER', widgets.gemini.provider);
            if (widgets.gemini.geminiModel) await db.setSetting('GEMINI_MODEL', widgets.gemini.geminiModel.replace(/^models\//, ''));
            if (widgets.gemini.claudeModel) await db.setSetting('CLAUDE_MODEL', widgets.gemini.claudeModel);
        }

        if (widgets['mcp-chat']) {
            if (widgets['mcp-chat'].provider) await db.setSetting('MCP_AI_PROVIDER', widgets['mcp-chat'].provider);
            if (widgets['mcp-chat'].geminiModel) await db.setSetting('GEMINI_MCP_CHAT_MODEL', widgets['mcp-chat'].geminiModel.replace(/^models\//, ''));
            if (widgets['mcp-chat'].claudeModel) await db.setSetting('CLAUDE_MCP_CHAT_MODEL', widgets['mcp-chat'].claudeModel);
        }

        if (widgets['knowledge-base']) {
            if (widgets['knowledge-base'].provider) await db.setSetting('RAG_AI_PROVIDER', widgets['knowledge-base'].provider);
            if (widgets['knowledge-base'].geminiModel) await db.setSetting('GEMINI_HTML_SVG_MODEL', widgets['knowledge-base'].geminiModel.replace(/^models\//, ''));
            if (widgets['knowledge-base'].localModel) await db.setSetting('LOCAL_AI_MODEL', widgets['knowledge-base'].localModel);
        }

        if (widgets['deep-research']) {
            if (widgets['deep-research'].provider) await db.setSetting('RESEARCH_AI_PROVIDER', widgets['deep-research'].provider);
            if (widgets['deep-research'].geminiModel) await db.setSetting('GEMINI_RESEARCH_MODEL', widgets['deep-research'].geminiModel.replace(/^models\//, ''));
        }

        if (widgets['live-concierge']) {
            if (widgets['live-concierge'].geminiModel) {
                await db.setSetting('GEMINI_LIVE_DEFAULT_MODEL', widgets['live-concierge'].geminiModel.replace(/^models\//, ''));
            }
        }

        res.json({ success: true, message: 'AIモデルルーティング設定を保存しました' });
    } catch (err) {
        console.error('[CorePlugins] Save AI routing error:', err);
        res.status(500).json({ error: 'AIモデルルーティングの保存に失敗しました' });
    }
});

// 7. GET /api/core/pdp - 次世代 ZTA Universal Role Builder & PDP ポリシー取得
router.get('/pdp', async (req, res) => {
    try {
        const rawPolicies = JSON.parse((await db.getSetting('RBAC_POLICIES')) || '{}');
        const mcpServers = await new Promise((resolve) => {
            db.all("SELECT id, name, endpoint_url, token_url, client_id, connection_mode, domain_key FROM mcp_servers ORDER BY created_at ASC", [], (err, rows) => {
                resolve(err ? [] : (rows || []));
            });
        });
        const pods = await new Promise((resolve) => {
            db.all("SELECT id, name, description FROM pods ORDER BY created_at ASC", [], (err, rows) => {
                resolve(err ? [] : (rows || []));
            });
        });
        const ragFolders = JSON.parse((await db.getSetting('GOOGLE_DRIVE_RAG_FOLDERS')) || '[]');
        const catalogData = await pluginManager.getFullPluginCatalog();
        const installedWidgetIds = (catalogData.installedWidgets || []).map(w => typeof w === 'string' ? w : w.id);

        const knownMcpIds = mcpServers.map(s => s.id);
        const hydratedPolicies = ztaPdpService.hydrateAllPolicies(rawPolicies, knownMcpIds, installedWidgetIds);
        const activePresets = ztaPdpService.filterRolePresetsByInstalledWidgets(installedWidgetIds);

        res.json({
            pdp: hydratedPolicies,
            policies: hydratedPolicies,
            presets: activePresets,
            rolePresets: activePresets,
            allPresets: ztaPdpService.ROLE_PRESET_TEMPLATES,
            installedWidgets: catalogData.installedWidgets,
            allWidgets: catalogData.widgets,
            mcpServers,
            pods,
            ragFolders
        });
    } catch (err) {
        console.error('[CorePlugins] GET /pdp error:', err);
        res.status(500).json({ error: 'ZTA PDPポリシーの取得に失敗しました' });
    }
});

// 8. POST /api/core/pdp - 次世代 ZTA Universal Role Builder ポリシーの保存 & レガシー互換コンパイル
router.post('/pdp', async (req, res) => {
    if (!hasAdminOrSettingPerm(req.user)) {
        return res.status(403).json({ error: 'ロール・権限の管理権限 (action:manage_roles) が必要です' });
    }

    try {
        const mcpServers = await new Promise((resolve) => {
            db.all("SELECT id FROM mcp_servers", [], (err, rows) => {
                resolve(err ? [] : (rows || []));
            });
        });
        const knownMcpIds = mcpServers.map(s => s.id);
        const catalogData = await pluginManager.getFullPluginCatalog();
        const installedWidgetIds = (catalogData.installedWidgets || []).map(w => typeof w === 'string' ? w : w.id);

        let targetPolicies = req.body.policies || req.body.pdp;

        if (req.body.applyPresetKey) {
            const presetKey = req.body.applyPresetKey;
            const preset = ztaPdpService.ROLE_PRESET_TEMPLATES[presetKey];
            if (!preset) {
                return res.status(400).json({ error: `未定義のロールプリセットです: ${presetKey}` });
            }
            const currentRaw = JSON.parse((await db.getSetting('RBAC_POLICIES')) || '{}');
            const hydratedCurrent = ztaPdpService.hydrateAllPolicies(currentRaw, knownMcpIds, installedWidgetIds);
            targetPolicies = {
                ...hydratedCurrent,
                [presetKey]: {
                    ...preset,
                    _grantsAuthoritative: Array.isArray(preset.grants)
                }
            };
        }

        if (!targetPolicies || typeof targetPolicies !== 'object') {
            return res.status(400).json({ error: 'ポリシーデータが含まれていません' });
        }
        if (!targetPolicies.admin) {
            targetPolicies.admin = ztaPdpService.hydrateRolePolicy('admin', {});
        }

        const compiledPolicies = {};
        for (const [roleKey, roleData] of Object.entries(targetPolicies)) {
            compiledPolicies[roleKey] = ztaPdpService.compileRolePolicy(roleKey, {
                ...roleData,
                _grantsAuthoritative: Boolean(roleData._grantsAuthoritative),
                _knownMcpIds: knownMcpIds,
                _installedWidgetIds: installedWidgetIds
            });
            delete compiledPolicies[roleKey]._knownMcpIds;
            delete compiledPolicies[roleKey]._installedWidgetIds;
            delete compiledPolicies[roleKey]._grantsAuthoritative;
        }

        await db.setSetting('RBAC_POLICIES', JSON.stringify(compiledPolicies));

        await auditDb.logEvent({
            userId: req.user?.id || null,
            userEmail: req.user?.email || null,
            eventType: 'rbac_pdp_updated',
            action: 'POST /api/core/pdp',
            status: 'success',
            req,
            details: { roles: Object.keys(compiledPolicies), appliedPreset: req.body.applyPresetKey || null }
        });

        res.json({
            success: true,
            pdp: compiledPolicies,
            policies: compiledPolicies,
            rbacPolicies: compiledPolicies
        });
    } catch (err) {
        console.error('[CorePlugins] POST /pdp error:', err);
        res.status(500).json({ error: 'ZTA PDPポリシーの保存に失敗しました' });
    }
});

// 9. POST /api/core/pdp/simulate - 1クリック ZTA PEP ロール権限シミュレーター (Dry-Run 検証)
router.post('/pdp/simulate', async (req, res) => {
    try {
        const { roleKeys = [], scenario = {}, draftPolicies = null } = req.body || {};
        const mcpServers = await new Promise((resolve) => {
            db.all("SELECT id, name FROM mcp_servers", [], (err, rows) => {
                resolve(err ? [] : (rows || []));
            });
        });
        const knownMcpIds = mcpServers.map(s => s.id);
        const rawPolicies = draftPolicies && typeof draftPolicies === 'object'
            ? draftPolicies
            : JSON.parse((await db.getSetting('RBAC_POLICIES')) || '{}');

        const result = ztaPdpService.evaluatePermissionSimulation(rawPolicies, roleKeys, scenario, knownMcpIds);
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        console.error('[CorePlugins] POST /pdp/simulate error:', err);
        res.status(500).json({ error: err.message || '権限シミュレーションに失敗しました' });
    }
});

module.exports = router;
