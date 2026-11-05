const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const tls = require('tls');
// Node.js 24 (OpenSSL 3.5) + Docker bridge MTU compatibility:
// Prevent oversized Post-Quantum X25519MLKEM768 TLS ClientHello fragmentation/reset on Cloudflare/Anthropic endpoints
tls.DEFAULT_ECDH_CURVE = 'X25519:P-256:P-384';
const { GoogleGenAI } = require("@google/genai");
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const db = require('./db.cjs');
const auditDb = require('./auditDb.cjs');
const { encrypt, decrypt } = require('./crypto.cjs');
const crypto = require('crypto');
const mcpChatRouter = require('./routes/mcpChat.cjs');
const llmAdapter = require('./services/llmAdapter.cjs');
const pluginManager = require('./services/pluginManager.cjs');
const ztaPdpService = require('./services/ztaPdpService.cjs');

// クライアントのIPアドレスおよびUser-AgentからZTA用のハッシュを生成するヘルパー関数
function getContextHashes(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    
    return { ipHash, uaHash, ip, ua };
}

// UI側のZTAセッションアイドルタイムアウト（30分: src/App.jsx の IDLE_TIMEOUT_MS と同期）
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_LOCK_MAX_COUNT = 6;

async function getSessionLockMaxCount() {
    try {
        const raw = await db.getSetting('SESSION_LOCK_MAX_COUNT');
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 48) {
            return parsed;
        }
    } catch (_) {}
    return DEFAULT_SESSION_LOCK_MAX_COUNT;
}

// WebAuthn (Passkey) チャレンジの一時保存ストア (5分間有効)
const webauthnChallenges = new Map();

function saveWebauthnChallenge(userId, challengeOrType, maybeType) {
    const now = Date.now();
    for (const [k, v] of webauthnChallenges.entries()) {
        if (v.expiresAt < now) webauthnChallenges.delete(k);
    }
    const isKnownType = (val) => val === 'create' || val === 'get';
    const type = isKnownType(maybeType) ? maybeType : challengeOrType;
    const challenge = isKnownType(maybeType) ? challengeOrType : maybeType;
    const key = `${userId}:${type}`;
    webauthnChallenges.set(key, {
        challenge,
        userId: Number(userId),
        type,
        expiresAt: now + 5 * 60 * 1000
    });
}

function consumeWebauthnChallenge(userId, type) {
    const key = `${userId}:${type}`;
    const entry = webauthnChallenges.get(key);
    webauthnChallenges.delete(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.challenge;
}

function getRpId(req) {
    if (req.headers.origin) {
        try {
            const originUrl = new URL(req.headers.origin);
            if (originUrl.hostname) return originUrl.hostname;
        } catch (_) {}
    }
    if (req.headers.referer) {
        try {
            const refUrl = new URL(req.headers.referer);
            if (refUrl.hostname) return refUrl.hostname;
        } catch (_) {}
    }
    const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || req.hostname || 'localhost').split(',')[0].trim();
    return rawHost.replace(/:\d+$/, '');
}

function getExpectedOrigins(req) {
    const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const rpId = getRpId(req);
    const origins = new Set([
        `https://${rawHost}`,
        `http://${rawHost}`,
        `https://${rpId}`,
        `http://${rpId}`,
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000'
    ]);
    if (req.headers.origin) {
        try {
            const url = new URL(req.headers.origin);
            if (url.hostname === rpId) {
                origins.add(url.origin);
            }
        } catch (_) {}
    }
    return Array.from(origins);
}

function getSessionCookieOptions(req, maxAge = 7 * 24 * 60 * 60 * 1000) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (req.headers.origin && req.headers.origin.startsWith('https://'));
    return {
        httpOnly: true,
        secure: Boolean(isHttps),
        sameSite: 'lax',
        path: '/',
        maxAge
    };
}

function clearSessionCookie(req, res) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || (req.headers.origin && req.headers.origin.startsWith('https://'));
    res.clearCookie('token', {
        httpOnly: true,
        secure: Boolean(isHttps),
        sameSite: 'lax',
        path: '/'
    });
    res.clearCookie('token');
}

function getDefaultOnlineStatusText(user) {
    if (!user) return 'Active';
    if (user.current_room === 'focus-zone') return 'Busy';
    if (user.current_room === 'remote' || user.is_remote) return 'Home Office';
    if (user.current_room && user.current_room.startsWith('meeting-room')) return 'In Meeting';
    return 'Active';
}

function isUserOffline(user, currentLoginUserId = null) {
    if (!user) return true;
    const statusLower = (user.status_text || '').toLowerCase();
    if (statusLower === 'offline') return true;
    if (!user.last_active_at) return true;
    const lastActiveMs = new Date(user.last_active_at).getTime();
    if (isNaN(lastActiveMs) || (Date.now() - lastActiveMs > SESSION_IDLE_TIMEOUT_MS)) {
        return true;
    }
    if (currentLoginUserId && Number(user.id) === Number(currentLoginUserId)) return false;
    return false;
}

// .env と development.env (Docker等でマウントされる名前) の両方をサポート
const fs = require('fs');
const path = require('path');

const envDataPath = path.resolve(__dirname, '../data/development.env');
const envLocalPath = path.resolve(__dirname, 'development.env');

if (fs.existsSync(envDataPath)) {
    console.log("Loading environment variables from data/development.env");
    dotenv.config({ path: envDataPath });
} else if (fs.existsSync(envLocalPath)) {
    console.log("Loading environment variables from development.env");
    dotenv.config({ path: envLocalPath });
} else {
    dotenv.config(); // fallback to default .env
}

// Encryption Key Validation & Generation Logic
if (!process.env.DB_ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === 'production' && process.env.DB_TYPE === 'postgres') {
        console.error("FATAL ERROR: DB_ENCRYPTION_KEY environment variable is missing for PostgreSQL production deployment.");
        console.error("Please inject it securely (e.g. via AWS Secrets Manager or Fargate Task Definition).");
        process.exit(1);
    } else {
        const newKey = crypto.randomBytes(32).toString('hex');
        process.env.DB_ENCRYPTION_KEY = newKey; // Set in memory
        
        const dataDir = path.resolve(__dirname, '../data');
        const isDataDirPersistent = fs.existsSync(dataDir);
        const envPath = isDataDirPersistent ? envDataPath : envLocalPath;
        
        const envLine = `\nDB_ENCRYPTION_KEY=${newKey}\n`;
        
        try {
            if (fs.existsSync(envPath)) {
                fs.appendFileSync(envPath, envLine);
            } else {
                fs.writeFileSync(envPath, envLine);
            }
            console.log(`Dynamically generated and saved new DB_ENCRYPTION_KEY to ${isDataDirPersistent ? 'data/development.env' : 'development.env'}`);
        } catch (fileErr) {
            console.error("Failed to write DB_ENCRYPTION_KEY to env file:", fileErr);
        }
    }
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Helper to get OAuth Client
async function getOAuthClient() {
    const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID;
    const clientSecret = await db.getSetting('GOOGLE_CLIENT_SECRET') || process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) return null;

    return new OAuth2Client(
        clientId,
        clientSecret,
        'postmessage'
    );
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Deep Research Published Reports (Public via UUID)
app.get('/reports/:id', requireAuthPage, (req, res) => {
    // Strip .html if provided by the user for convenience
    const id = req.params.id.replace(/\.html$/, '');
    
    db.get("SELECT content, mime_type FROM published_reports WHERE id = ?", [id], (err, row) => {
        if (err || !row) {
            return res.status(404).send('<h1>404 Not Found</h1><p>The requested report does not exist or has been removed.</p>');
        }
        res.type(row.mime_type || 'text/html');
        // Serve raw content directly
        res.send(row.content);
    });
});

// Config: Get public config and status (sensitive fields require valid session)
app.get('/api/config', async (req, res) => {
    console.log("Config endpoint hit");
    try {
        const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID;
        const clientSecret = await db.getSetting('GOOGLE_CLIENT_SECRET') || process.env.GOOGLE_CLIENT_SECRET;
        const geminiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const claudeKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeKey && !geminiKey ? 'claude' : 'gemini');
        const isConfigured = !!(clientId && clientSecret);

        let maskedClientId = '';
        if (clientId && clientId.length > 20) {
            maskedClientId = clientId.substring(0, 15) + '...' + clientId.substring(clientId.length - 5);
        } else {
            maskedClientId = clientId || '';
        }

        // Verify session token for sensitive configuration fields (ZTA enforcement)
        let isAuthenticatedSession = false;
        const token = req.cookies?.token;
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
                const hashes = getContextHashes(req);
                const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
                if (isContextValid && decoded.id) {
                    const userExists = await new Promise((resolve) => {
                        db.get("SELECT id FROM users WHERE id = ?", [decoded.id], (err, row) => resolve(!err && !!row));
                    });
                    isAuthenticatedSession = userExists;
                }
            } catch (_) {
                isAuthenticatedSession = false;
            }
        }

        const sessionLockMaxCount = await getSessionLockMaxCount();
        const pluginCatalogData = await pluginManager.getFullPluginCatalog();

        // Unauthenticated or timed-out requests only receive public bootstrap status
        if (!isAuthenticatedSession) {
            return res.json({
                clientId,
                maskedClientId,
                isConfigured,
                isGeminiConfigured: !!geminiKey,
                isClaudeConfigured: !!claudeKey,
                aiProvider,
                sessionLockMaxCount,
                installedWidgets: pluginCatalogData.installedWidgets,
                availableAddons: pluginCatalogData.availableAddons,
                capabilities: pluginCatalogData.capabilities
            });
        }

        const googleDriveRootId = await db.getSetting('GOOGLE_DRIVE_ROOT_ID');
        
        let googleDriveRagFolders = [];
        try {
            googleDriveRagFolders = JSON.parse(await db.getSetting('GOOGLE_DRIVE_RAG_FOLDERS') || '[]');
        } catch (e) {
            googleDriveRagFolders = [];
        }
        if (googleDriveRagFolders.length === 0) {
            const oldFolderId = await db.getSetting('GOOGLE_DRIVE_RAG_FOLDER_ID');
            if (oldFolderId) {
                googleDriveRagFolders = [{ id: oldFolderId, name: 'Default RAG Folder' }];
            }
        }

        const geminiModel = await db.getSetting('GEMINI_MODEL');
        const claudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';

        const lastRagSyncTime = await db.getSetting('LAST_RAG_SYNC_TIME');
        const geminiResearchFolderId = await db.getSetting('GEMINI_RESEARCH_FOLDER_ID');
        const globalGeminiModel = geminiModel || 'gemini-3.6-flash';
        const globalClaudeModel = claudeModel || 'claude-sonnet-4-6';
        const nanoBananaModel = await db.getSetting('GEMINI_NANO_BANANA_MODEL') || globalGeminiModel;
        const geminiResearchModel = await db.getSetting('GEMINI_RESEARCH_MODEL') || globalGeminiModel;
        const geminiHtmlSvgModel = await db.getSetting('GEMINI_HTML_SVG_MODEL') || globalGeminiModel;
        const geminiMcpChatModel = await db.getSetting('GEMINI_MCP_CHAT_MODEL') || globalGeminiModel;
        const claudeResearchModel = await db.getSetting('CLAUDE_RESEARCH_MODEL') || globalClaudeModel;
        const claudeHtmlSvgModel = await db.getSetting('CLAUDE_HTML_SVG_MODEL') || globalClaudeModel;
        const claudeMcpChatModel = await db.getSetting('CLAUDE_MCP_CHAT_MODEL') || globalClaudeModel;
        const nanoBananaPrompt = await db.getSetting('NANO_BANANA_2_PROMPT') || '';
        const deepResearchPrompt = await db.getSetting('DEEP_RESEARCH_PROMPT') || '';
        const htmlSvgPrompt = await db.getSetting('HTML_SVG_PROMPT') || '';
        const mcpServerEndpoint = await db.getSetting('MCP_SERVER_ENDPOINT') || '';
        const mcpTokenUrl = await db.getSetting('MCP_TOKEN_URL') || '';
        const mcpClientId = await db.getSetting('MCP_CLIENT_ID') || '';
        const mcpClientSecret = await db.getSetting('MCP_CLIENT_SECRET');
        const isMcpSecretConfigured = !!mcpClientSecret;

        let rbacPolicies;
        try {
            rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
        } catch (e) {
            rbacPolicies = {};
        }
        
        let mcpQuickPrompts;
        try {
            mcpQuickPrompts = JSON.parse(await db.getSetting('MCP_QUICK_PROMPTS') || '[]');
        } catch (e) {
            mcpQuickPrompts = [];
        }

        const defaultWorkflowId = await db.getSetting('DEFAULT_DEEP_RESEARCH_WORKFLOW_ID') || '';
        const defaultAssistantPrompt = await db.getSetting('DEFAULT_ASSISTANT_PROMPT') || '';
        const companyWorkPolicy = await db.getSetting('COMPANY_WORK_POLICY') || '';

        // Antigravity Agent Configuration Settings
        const antigravityAgentModel = await db.getSetting('ANTIGRAVITY_AGENT_MODEL') || globalGeminiModel;
        const antigravityAgentInstructions = await db.getSetting('ANTIGRAVITY_AGENT_SYSTEM_INSTRUCTIONS') || '';
        const antigravityAgentSafetyPolicy = await db.getSetting('ANTIGRAVITY_AGENT_SAFETY_POLICY') || 'confirm_run_command';
        const antigravityAgentExternalPolicyEnabled = (await db.getSetting('ANTIGRAVITY_AGENT_EXTERNAL_POLICY_ENABLED') || 'true') === 'true';
        const antigravityAgentMcpServers = await db.getSetting('ANTIGRAVITY_AGENT_MCP_SERVERS') || '[]';

        // Local AI / Gemma 4 Settings
        const localAiEnabled = (await db.getSetting('LOCAL_AI_ENABLED')) || 'true';
        const localAiHost = (await db.getSetting('LOCAL_AI_HOST')) || 'http://localhost:11434';
        const localAiModel = (await db.getSetting('LOCAL_AI_MODEL')) || 'gemma4:26b-mlx';
        const localAiTemperature = (await db.getSetting('LOCAL_AI_TEMPERATURE')) || '0.7';

        // Gemini Live Concierge Settings
        let geminiLiveAvailableModels;
        try {
            const liveModelsRaw = await db.getSetting('GEMINI_LIVE_AVAILABLE_MODELS');
            if (liveModelsRaw) {
                geminiLiveAvailableModels = JSON.parse(liveModelsRaw);
            } else {
                geminiLiveAvailableModels = [
                    { id: 'gemini-3.8-live', name: 'Gemini 3.8 Flash Live', description: '最新・音声リアルタイム対話 / 推奨' },
                    { id: 'gemini-3.8-live-extended-thinking', name: 'Gemini 3.8 Flash Live (Extended Thinking)', description: '深層推論対応 Live 対話モデル' }
                ];
            }
        } catch (_) {
            geminiLiveAvailableModels = [
                { id: 'gemini-3.8-live', name: 'Gemini 3.8 Flash Live', description: '最新・音声リアルタイム対話 / 推奨' },
                { id: 'gemini-3.8-live-extended-thinking', name: 'Gemini 3.8 Flash Live (Extended Thinking)', description: '深層推論対応 Live 対話モデル' }
            ];
        }
        const geminiLiveDefaultModel = await db.getSetting('GEMINI_LIVE_DEFAULT_MODEL') || 'gemini-3.8-live';

        const mcpChatSystemInstruction = await db.getSetting('MCP_CHAT_SYSTEM_INSTRUCTION') || '';
        const mcpChatMaxTurns = parseInt(await db.getSetting('MCP_CHAT_MAX_TURNS')) || 15;
        const defaultMcpChatSystemInstruction = mcpChatRouter.DEFAULT_MCP_CHAT_SYSTEM_INSTRUCTION || '';

        // Widget Plugin & Capability Bus State (EmployeeAgent-Core Microkernel)
        const chatAiProvider = await db.getSetting('CHAT_AI_PROVIDER') || aiProvider;
        const mcpAiProvider = await db.getSetting('MCP_AI_PROVIDER') || aiProvider;
        const ragAiProvider = await db.getSetting('RAG_AI_PROVIDER') || aiProvider;
        const researchAiProvider = await db.getSetting('RESEARCH_AI_PROVIDER') || aiProvider;

        res.json({
            clientId, // Expose full client ID for frontend auth
            maskedClientId,
            isConfigured,
            isGeminiConfigured: !!geminiKey,
            isClaudeConfigured: !!claudeKey,
            aiProvider,
            chatAiProvider,
            mcpAiProvider,
            ragAiProvider,
            researchAiProvider,
            installedWidgets: pluginCatalogData.installedWidgets,
            availableAddons: pluginCatalogData.availableAddons,
            capabilities: pluginCatalogData.capabilities,
            geminiModel,
            claudeModel,
            googleDriveRootId: googleDriveRootId || '',
            googleDriveRagFolders,
            lastRagSyncTime: lastRagSyncTime || null,
            lastRagSyncTimeGemini: await db.getSetting('LAST_RAG_SYNC_TIME_GEMINI') || lastRagSyncTime || null,
            lastRagSyncTimeClaude: await db.getSetting('LAST_RAG_SYNC_TIME_CLAUDE') || lastRagSyncTime || null,
            geminiResearchFolderId: geminiResearchFolderId || '',
            nanoBananaModel,
            geminiResearchModel,
            geminiHtmlSvgModel,
            geminiMcpChatModel,
            claudeResearchModel,
            claudeHtmlSvgModel,
            claudeMcpChatModel,
            nanoBananaPrompt,
            deepResearchPrompt,
            htmlSvgPrompt,
            mcpServerEndpoint,
            mcpTokenUrl,
            mcpClientId,
            isMcpSecretConfigured,
            rbacPolicies,
            mcpQuickPrompts,
            defaultWorkflowId,
            defaultAssistantPrompt,
            companyWorkPolicy,
            antigravityAgentModel,
            antigravityAgentInstructions,
            antigravityAgentSafetyPolicy,
            antigravityAgentExternalPolicyEnabled,
            antigravityAgentMcpServers,
            localAiEnabled,
            localAiHost,
            localAiModel,
            localAiTemperature,
            geminiLiveAvailableModels,
            geminiLiveDefaultModel,
            mcpChatSystemInstruction,
            mcpChatMaxTurns,
            defaultMcpChatSystemInstruction,
            sessionLockMaxCount
        });
    } catch (error) {
        console.error("Config Error:", error);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

async function requireAuthIfConfigured(req, res, next) {
    try {
        const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID;
        const clientSecret = await db.getSetting('GOOGLE_CLIENT_SECRET') || process.env.GOOGLE_CLIENT_SECRET;
        const isConfigured = !!(clientId && clientSecret);

        if (!isConfigured) {
            req.user = { id: 0, email: 'system@init', role: 'admin', allowed_actions: ['*'] };
            return next();
        }
    } catch (e) {
        console.error("Config check in auth middleware error:", e);
    }
    return requireAuth(req, res, next);
}

app.post('/api/config', requireAuthIfConfigured, async (req, res) => {
    const { googleClientId, googleClientSecret, geminiApiKey, geminiModel, claudeApiKey, claudeModel, aiProvider, claudeResearchModel, claudeHtmlSvgModel, claudeMcpChatModel, googleDriveRootId, googleDriveRagFolders, geminiResearchFolderId, nanoBananaModel, geminiResearchModel, geminiHtmlSvgModel, nanoBananaPrompt, deepResearchPrompt, htmlSvgPrompt, mcpServerEndpoint, mcpTokenUrl, mcpClientId, mcpClientSecret, rbacPolicies, mcpQuickPrompts, geminiMcpChatModel, defaultWorkflowId, defaultAssistantPrompt, companyWorkPolicy, antigravityAgentModel, antigravityAgentInstructions, antigravityAgentSafetyPolicy, antigravityAgentExternalPolicyEnabled, antigravityAgentMcpServers, localAiEnabled, localAiHost, localAiModel, localAiTemperature, geminiLiveAvailableModels, geminiLiveDefaultModel, mcpChatSystemInstruction, mcpChatMaxTurns, sessionLockMaxCount } = req.body;

    try {
        const isConfigured = !!(await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID);

        // ZTA Security Boundary Check: Block external domain users
        if (isConfigured && await isExternalUser(req.user)) {
            return res.status(403).json({ error: 'Permission denied. External domain users cannot change system configurations.' });
        }

        // If this is initial activation (first time setup), set FIRST_ADMIN_PENDING flag
        if (!isConfigured && googleClientId && googleClientSecret) {
            await db.setSetting('FIRST_ADMIN_PENDING', 'true');
        }

        const allowedActions = req.user?.allowed_actions || [];
        const hasWildcard = allowedActions.includes('*') || req.user?.id === 0 || !isConfigured;
        const hasSysSettings = hasWildcard || allowedActions.includes('action:manage_system_settings');
        const hasWorkPolicy = hasWildcard || allowedActions.includes('action:manage_work_policy');
        const hasWorkflowEdit = hasWildcard || allowedActions.includes('action:edit_workflow_model') || hasSysSettings;
        const hasRagManage = hasWildcard || allowedActions.includes('action:manage_rag_folders') || hasSysSettings;
        const hasRolesManage = hasWildcard || allowedActions.includes('action:manage_roles');

        // Manage Work Policy field
        if (companyWorkPolicy !== undefined) {
            if (!hasWorkPolicy) return res.status(403).json({ error: 'Permission denied. Requires action:manage_work_policy' });
            await db.setSetting('COMPANY_WORK_POLICY', companyWorkPolicy);
        }

        // Manage System Settings fields (including Antigravity Agent Settings & Live Concierge Settings)
        if (hasSysSettings) {
            if (googleClientId && !googleClientId.includes('...')) {
                const currentClientId = await db.getSetting('GOOGLE_CLIENT_ID');
                const cleanClientId = googleClientId.trim();
                if (cleanClientId !== currentClientId) {
                    const clientIdPattern = /^[0-9]+-[a-zA-Z0-9_]+\.apps\.googleusercontent\.com$/;
                    if (!clientIdPattern.test(cleanClientId)) {
                        return res.status(400).json({ error: '無効な Google Client ID 形式です。形式をご確認ください。' });
                    }
                    await db.setSetting('GOOGLE_CLIENT_ID', cleanClientId);
                }
            }
            if (googleClientSecret) {
                await db.setSetting('GOOGLE_CLIENT_SECRET', googleClientSecret.trim());
            }
            if (geminiApiKey) {
                await db.setSetting('GEMINI_API_KEY', geminiApiKey.trim());
            }
            if (claudeApiKey) {
                await db.setSetting('CLAUDE_API_KEY', claudeApiKey.trim());
            }
            if (aiProvider && (aiProvider === 'gemini' || aiProvider === 'claude')) {
                await db.setSetting('AI_PROVIDER', aiProvider);
            }
            if (mcpServerEndpoint !== undefined) await db.setSetting('MCP_SERVER_ENDPOINT', mcpServerEndpoint);
            if (mcpTokenUrl !== undefined) await db.setSetting('MCP_TOKEN_URL', mcpTokenUrl);
            if (mcpClientId !== undefined) await db.setSetting('MCP_CLIENT_ID', mcpClientId);
            if (mcpClientSecret !== undefined) await db.setSetting('MCP_CLIENT_SECRET', mcpClientSecret);
            if (googleDriveRootId !== undefined) await db.setSetting('GOOGLE_DRIVE_ROOT_ID', googleDriveRootId);
            if (mcpQuickPrompts !== undefined) await db.setSetting('MCP_QUICK_PROMPTS', JSON.stringify(mcpQuickPrompts));
            if (defaultAssistantPrompt !== undefined) await db.setSetting('DEFAULT_ASSISTANT_PROMPT', defaultAssistantPrompt);

            // MCP Chat Harness & System Instructions Persistence
            if (mcpChatSystemInstruction !== undefined) await db.setSetting('MCP_CHAT_SYSTEM_INSTRUCTION', mcpChatSystemInstruction);
            if (mcpChatMaxTurns !== undefined) await db.setSetting('MCP_CHAT_MAX_TURNS', mcpChatMaxTurns.toString());
            
            // Local AI (Gemma 4) Settings Persistence
            if (localAiEnabled !== undefined) await db.setSetting('LOCAL_AI_ENABLED', localAiEnabled.toString());
            if (localAiHost !== undefined) await db.setSetting('LOCAL_AI_HOST', localAiHost);
            if (localAiModel !== undefined) await db.setSetting('LOCAL_AI_MODEL', localAiModel);
            if (localAiTemperature !== undefined) await db.setSetting('LOCAL_AI_TEMPERATURE', localAiTemperature.toString());

            // Antigravity Agent Parameter Persistence
            if (antigravityAgentModel !== undefined) await db.setSetting('ANTIGRAVITY_AGENT_MODEL', antigravityAgentModel);
            if (antigravityAgentInstructions !== undefined) await db.setSetting('ANTIGRAVITY_AGENT_SYSTEM_INSTRUCTIONS', antigravityAgentInstructions);
            if (antigravityAgentSafetyPolicy !== undefined) await db.setSetting('ANTIGRAVITY_AGENT_SAFETY_POLICY', antigravityAgentSafetyPolicy);
            if (antigravityAgentExternalPolicyEnabled !== undefined) await db.setSetting('ANTIGRAVITY_AGENT_EXTERNAL_POLICY_ENABLED', antigravityAgentExternalPolicyEnabled.toString());
            if (antigravityAgentMcpServers !== undefined) await db.setSetting('ANTIGRAVITY_AGENT_MCP_SERVERS', antigravityAgentMcpServers);

            // Gemini Live Concierge Settings (Admin only)
            if (geminiLiveAvailableModels !== undefined) {
                const liveModelsStr = typeof geminiLiveAvailableModels === 'string' ? geminiLiveAvailableModels : JSON.stringify(geminiLiveAvailableModels);
                await db.setSetting('GEMINI_LIVE_AVAILABLE_MODELS', liveModelsStr);
            }
            if (geminiLiveDefaultModel !== undefined) {
                await db.setSetting('GEMINI_LIVE_DEFAULT_MODEL', geminiLiveDefaultModel);
            }
            if (sessionLockMaxCount !== undefined) {
                const parsedMax = Math.max(1, Math.min(48, parseInt(sessionLockMaxCount, 10) || DEFAULT_SESSION_LOCK_MAX_COUNT));
                await db.setSetting('SESSION_LOCK_MAX_COUNT', parsedMax.toString());
            }
        }

        const allowedWidgets = req.user.allowed_widgets || [];
        const hasBase = hasWorkflowEdit || allowedWidgets.includes('workflow:deepresearch_html') || allowedWidgets.includes('workflow:deepresearch_infographic') || allowedWidgets.includes('workflow:deepresearch_full');
        const hasHtml = hasWorkflowEdit || allowedWidgets.includes('workflow:deepresearch_html') || allowedWidgets.includes('workflow:deepresearch_full');
        const hasInfo = hasWorkflowEdit || allowedWidgets.includes('workflow:deepresearch_infographic') || allowedWidgets.includes('workflow:deepresearch_full');

        // Manage General Gemini & Claude Model
        if (geminiModel) {
            if (!hasWorkflowEdit) return res.status(403).json({ error: 'Permission denied. Requires action:edit_workflow_model' });
            await db.setSetting('GEMINI_MODEL', geminiModel);
        }
        if (claudeModel) {
            if (!hasWorkflowEdit) return res.status(403).json({ error: 'Permission denied. Requires action:edit_workflow_model' });
            await db.setSetting('CLAUDE_MODEL', claudeModel);
        }

        // Manage MCP Chat Model
        if (geminiMcpChatModel) {
            if (!hasSysSettings) return res.status(403).json({ error: 'Permission denied. Requires action:manage_system_settings' });
            await db.setSetting('GEMINI_MCP_CHAT_MODEL', geminiMcpChatModel);
        }
        if (claudeMcpChatModel) {
            if (!hasSysSettings) return res.status(403).json({ error: 'Permission denied. Requires action:manage_system_settings' });
            await db.setSetting('CLAUDE_MCP_CHAT_MODEL', claudeMcpChatModel);
        }

        // Manage Base Research Model fields
        if (geminiResearchModel || claudeResearchModel || deepResearchPrompt !== undefined || geminiResearchFolderId !== undefined) {
            if (!hasBase) return res.status(403).json({ error: 'Permission denied. Requires workflow:deepresearch_*' });
            if (geminiResearchModel) await db.setSetting('GEMINI_RESEARCH_MODEL', geminiResearchModel);
            if (claudeResearchModel) await db.setSetting('CLAUDE_RESEARCH_MODEL', claudeResearchModel);
            if (deepResearchPrompt !== undefined) await db.setSetting('DEEP_RESEARCH_PROMPT', deepResearchPrompt);
            if (geminiResearchFolderId !== undefined) await db.setSetting('GEMINI_RESEARCH_FOLDER_ID', geminiResearchFolderId);
        }

        // Manage HTML/SVG Model fields
        if (geminiHtmlSvgModel || claudeHtmlSvgModel || htmlSvgPrompt !== undefined) {
            if (!hasHtml) return res.status(403).json({ error: 'Permission denied. Requires workflow:deepresearch_html' });
            if (geminiHtmlSvgModel) await db.setSetting('GEMINI_HTML_SVG_MODEL', geminiHtmlSvgModel);
            if (claudeHtmlSvgModel) await db.setSetting('CLAUDE_HTML_SVG_MODEL', claudeHtmlSvgModel);
            if (htmlSvgPrompt !== undefined) await db.setSetting('HTML_SVG_PROMPT', htmlSvgPrompt);
        }

        // Manage Infographic Model fields
        if (nanoBananaModel || nanoBananaPrompt !== undefined) {
            if (!hasInfo) return res.status(403).json({ error: 'Permission denied. Requires workflow:deepresearch_infographic' });
            if (nanoBananaModel) await db.setSetting('GEMINI_NANO_BANANA_MODEL', nanoBananaModel);
            if (nanoBananaPrompt !== undefined) await db.setSetting('NANO_BANANA_2_PROMPT', nanoBananaPrompt);
        }

        // Manage RAG Folders fields
        if (googleDriveRagFolders !== undefined) {
            if (!hasRagManage) return res.status(403).json({ error: 'Permission denied. Requires action:manage_rag_folders' });
            await db.setSetting('GOOGLE_DRIVE_RAG_FOLDERS', JSON.stringify(googleDriveRagFolders));
        }

        if (req.body.rbacPolicies) {
            if (!hasRolesManage) return res.status(403).json({ error: 'Permission denied. Requires action:manage_roles' });
            
            // Safety Validation: Safeguard 1 - Policy check for lockout prevention
            const newPolicies = req.body.rbacPolicies;
            const adminPolicy = newPolicies.admin;
            if (!adminPolicy) {
                return res.status(400).json({ error: 'Cannot save policy: admin role definition is missing.' });
            }
            const allowedActions = adminPolicy.allowed_actions || [];
            const hasRequiredActions = allowedActions.includes('*') || 
                (allowedActions.includes('action:manage_roles') && allowedActions.includes('action:manage_system_settings'));
            if (!hasRequiredActions) {
                return res.status(400).json({ error: 'Cannot save policy: admin role must retain manage_roles and manage_system_settings permissions.' });
            }

            await db.setSetting('RBAC_POLICIES', JSON.stringify(newPolicies));
        }

        // Manage Default Workflow
        if (defaultWorkflowId !== undefined) {
            if (!hasWorkflowEdit && !hasSysSettings) return res.status(403).json({ error: 'Permission denied. Requires action:edit_workflow_model or manage_system_settings' });
            await db.setSetting('DEFAULT_DEEP_RESEARCH_WORKFLOW_ID', defaultWorkflowId);
        }

        // 成功を監査ログに記録
        auditDb.logEvent({
            userId: req.user.id,
            userEmail: req.user.email,
            eventType: 'config_changed',
            action: 'POST /api/config',
            status: 'success',
            req: req,
            details: { message: 'System configuration settings updated successfully' }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Save Config Error:", error);
        
        // 失敗を監査ログに記録
        auditDb.logEvent({
            userId: req?.user?.id || null,
            userEmail: req?.user?.email || null,
            eventType: 'config_changed',
            action: 'POST /api/config',
            status: 'failure',
            req: req,
            details: { error: error.message }
        });

        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ... (Auth endpoints skipped for brevity in replacement, but need to ensure context matches) ...

// ... (Gemini endpoints skipped) ...

// ... (FS endpoints skipped) ...

// Google Drive API endpoints are defined later in the file
const { google } = require('googleapis');

// Import new Deep Research route
const deepResearchModule = require('./routes/deepResearch.cjs');
app.use('/api/research', requireWidgetAccess('app:deep-research'), deepResearchModule.router);

// Import new Knowledge Base route
const knowledgeModule = require('./routes/knowledge.cjs');
app.use('/api/knowledge', requireWidgetAccess('app:knowledge-base'), knowledgeModule.router);

// Import Pods route
const podsModule = require('./routes/pods.cjs');
app.use('/api/pods', requireAuth, podsModule.router);

// Knowledge Base MCP Server route
const knowledgeMcpModule = require('./routes/knowledgeMcp.cjs');
app.use('/api/mcp/knowledge', knowledgeMcpModule.router);

// Gemma 4 Local AI MCP Server route
const gemmaMcpRouter = require('./routes/gemmaMcp.cjs');
app.use('/api/mcp/gemma', gemmaMcpRouter);

function resolveLocalAiHost(configuredHost) {
    let host = configuredHost || 'http://localhost:11434';
    if (process.env.DOCKER_CONTAINER || fs.existsSync('/.dockerenv')) {
        if (host.includes('localhost') || host.includes('127.0.0.1')) {
            host = host.replace('localhost', 'host.docker.internal').replace('127.0.0.1', 'host.docker.internal');
        }
    } else {
        // Fix for Node 18+ native fetch IPv6 issue with localhost
        if (host.includes('localhost')) {
            host = host.replace('localhost', '127.0.0.1');
        }
    }
    return host.replace(/\/$/, '');
}

// Gemma 4 LiveStream & Models API
app.get('/api/gemma/models', requireAuth, async (req, res) => {
    try {
        const rawHost = (await db.getSetting('LOCAL_AI_HOST')) || 'http://localhost:11434';
        const host = resolveLocalAiHost(rawHost);
        const response = await fetch(`${host}/api/tags`);
        if (!response.ok) {
            return res.status(502).json({ error: 'Failed to connect to local Ollama server' });
        }
        const data = await response.json();
        res.json({ models: data.models || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gemma/stream', requireAuth, async (req, res) => {
    const { prompt, systemInstruction, temperature, model: requestedModel } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        const rawHost = (await db.getSetting('LOCAL_AI_HOST')) || 'http://localhost:11434';
        const host = resolveLocalAiHost(rawHost);
        const defaultModel = (await db.getSetting('LOCAL_AI_MODEL')) || 'gemma4:26b-mlx';
        const model = requestedModel || defaultModel;
        const temp = temperature !== undefined ? parseFloat(temperature) : parseFloat((await db.getSetting('LOCAL_AI_TEMPERATURE')) || '0.7');

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const ollamaRes = await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                system: systemInstruction || undefined,
                stream: true,
                options: { temperature: temp }
            })
        });

        if (!ollamaRes.ok) {
            const errText = await ollamaRes.text();
            res.write(`data: ${JSON.stringify({ error: `Ollama error: ${errText}` })}\n\n`);
            return res.end();
        }

        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    res.write(`data: ${JSON.stringify({ 
                        text: json.response || '', 
                        done: json.done || false,
                        prompt_eval_count: json.prompt_eval_count,
                        eval_count: json.eval_count
                    })}\n\n`);
                } catch (e) {}
            }
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (err) {
        console.error('[Gemma Stream Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
});

// Skill Management Routes
app.use('/api/skills', requireAuth, require('./routes/skills.cjs'));

// MCP Servers requires either manage_system_settings or manage_roles
app.use('/api/mcp/servers', requireAuth, (req, res, next) => {
    const allowed = req.user.allowed_actions || [];
    if (allowed.includes('*') || allowed.includes('action:manage_system_settings') || allowed.includes('action:manage_roles')) {
        next();
    } else {
        res.status(403).json({ error: 'Permission denied' });
    }
}, require('./routes/mcpServers.cjs'));

app.use('/api/mcp/chat', requireWidgetAccess('app:mcp-chat'), require('./routes/mcpChat.cjs'));
app.use('/api/mcp/tasks', requireWidgetAccess('app:mcp-chat'), require('./routes/mcpChat.cjs'));
app.use('/api/mcp/meta', requireWidgetAccess('app:mcp-chat'), require('./routes/mcpChat.cjs'));
app.use('/api/local-rag', requireAuth, require('./routes/localRag.cjs'));
app.use('/api/gemini-live', requireAuth, require('./routes/geminiLive.cjs').router);
app.use('/api/zta/audit', requireAuth, require('./routes/ztaAudit.cjs'));
app.use('/api/core', requireAuthIfConfigured, require('./routes/corePlugins.cjs'));

// MCP Tool Execution Route
const { callMcpTool } = require('./mcpClient.cjs');

app.post('/api/mcp/tool', requireWidgetAccess('app:mcp-chat'), requirePermission('action:use_mcp_tools'), async (req, res) => {
    const { name, args, serverId } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'Tool name is required' });
    }

    // Granular MCP Check
    if (serverId) {
        const allowedWidgets = req.user.allowed_widgets || [];
        if (!allowedWidgets.includes('*') && !allowedWidgets.includes(`mcp:${serverId}`)) {
            console.warn(`[SECURITY AUDIT] 🚨 DOUBLE-CHECK BLOCKED: User '${req.user?.email}' attempted access to unauthorized MCP server '${serverId}'`);
            await auditDb.logEvent({
                userId: req.user?.id || null,
                userEmail: req.user?.email || null,
                eventType: 'mcp_tool_access_blocked',
                action: `BLOCKED_UNAUTHORIZED_SERVER_ACCESS: ${serverId}`,
                status: 'blocked',
                req: req,
                details: {
                    serverId,
                    toolName: name,
                    arguments: args,
                    reason: `Requires widget access: mcp:${serverId}`,
                    doubleCheckEnforced: true
                }
            });
            return res.status(403).json({ error: `Access denied. Requires widget access: mcp:${serverId}` });
        }
    }

    try {
        const result = await callMcpTool(name, args, req.user.allowed_widgets || [], req.user, req);
        res.json(result);
    } catch (error) {
        console.error(`MCP Proxy Error for tool ${name}:`, error.message);
        res.status(error.message.includes('Access denied') ? 403 : 500).json({ error: error.message || 'Failed to execute MCP tool' });
    }
});

// Auth: Exchange code for token
app.post('/api/auth/google', async (req, res) => {
    const { code } = req.body;
    try {
        const oAuth2Client = await getOAuthClient();
        if (!oAuth2Client) {
            return res.status(500).json({ error: 'Server not configured' });
        }

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get Client ID again for verification
        const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID;

        const ticket = await oAuth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: clientId,
        });
        const payload = ticket.getPayload();

        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name;
        const avatarUrl = payload.picture;
        const accessToken = encrypt(tokens.access_token);
        const refreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
        const expiryDate = tokens.expiry_date || null;

        // 1. Check if user already exists
        db.get("SELECT * FROM users WHERE google_id = ? OR email = ?", [googleId, email], (err, existingUser) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            const proceedWithLogin = async (role) => {
                let rbacPolicies = {};
                try {
                    const rbacJson = await db.getSetting('RBAC_POLICIES');
                    if (rbacJson) rbacPolicies = JSON.parse(rbacJson);
                } catch (e) {
                    console.error("Failed to fetch RBAC_POLICIES for JWT generation", e);
                }

                const roles = (role || 'user').split(',').map(r => r.trim());
                let allowed_widgets_set = new Set();
                let allowed_actions_set = new Set();
                let allowed_models_set = new Set();
                let allowed_pods_set = new Set();
                let hasWildcardModels = false;

                roles.forEach(r => {
                    const policy = rbacPolicies[r] || rbacPolicies['user'] || {};
                    (policy.allowed_widgets || []).forEach(w => allowed_widgets_set.add(w));
                    (policy.allowed_actions || []).forEach(a => allowed_actions_set.add(a));
                    (policy.allowed_pods || []).forEach(p => allowed_pods_set.add(p));
                    (policy.allowed_models || []).forEach(m => {
                        if (m === '*') hasWildcardModels = true;
                        allowed_models_set.add(m);
                    });
                });

                // Enforce Universal Default Widgets for profile management
                ['app:settings'].forEach(w => allowed_widgets_set.add(w));

                const isAdmin = roles.includes('admin');
                const allowed_widgets = (isAdmin || allowed_widgets_set.has('*')) ? ['*'] : Array.from(allowed_widgets_set);
                const allowed_actions = (isAdmin || allowed_actions_set.has('*')) ? ['*'] : Array.from(allowed_actions_set);
                const allowed_models = (isAdmin || hasWildcardModels) ? ['*'] : Array.from(allowed_models_set);
                const allowed_pods = (isAdmin || allowed_pods_set.has('*')) ? ['*'] : Array.from(allowed_pods_set);

                const nowIso = new Date().toISOString();
                db.run(`INSERT INTO users (google_id, email, name, avatar_url, access_token, refresh_token, role, token_expiry, last_active_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
                    ON CONFLICT(google_id) DO UPDATE SET 
                    email=excluded.email, name=excluded.name, avatar_url = CASE WHEN users.avatar_url LIKE 'data:image%' THEN users.avatar_url ELSE excluded.avatar_url END, access_token=excluded.access_token, token_expiry=excluded.token_expiry, last_active_at=excluded.last_active_at, status_text = CASE WHEN LOWER(COALESCE(users.status_text, '')) = 'offline' THEN 'Active' ELSE COALESCE(users.status_text, 'Active') END` + (refreshToken ? `, refresh_token=excluded.refresh_token` : ``),
                    [googleId, email, name, avatarUrl, accessToken, refreshToken || null, role, expiryDate, nowIso],
                    function (err) {
                        if (err) {
                            console.error("DB Upsert Error:", err);
                            return res.status(500).json({ error: 'Database error' });
                        }
                        
                        // ID could be from existing user or newly generated
                        const userId = existingUser ? existingUser.id : this.lastID;

                        // Delete from invitations if they just joined via an invite
                        db.run("DELETE FROM invitations WHERE email = ? AND ? != 'admin'", [email, role]);

                        // Create Session JWT (ZTA PDP Action: Embedding Claims with Context Bindings)
                        const hashes = getContextHashes(req);
                        const token = jwt.sign(
                            { 
                                id: userId, 
                                googleId, 
                                email, 
                                name, 
                                role, 
                                allowed_widgets, 
                                allowed_actions, 
                                allowed_models,
                                allowed_pods,
                                ip_hash: hashes.ipHash,
                                ua_hash: hashes.uaHash
                            },
                            process.env.JWT_SECRET || 'secret',
                            { expiresIn: '7d' }
                        );

                        // 監査ログに成功を記録
                        auditDb.logEvent({
                            userId: userId,
                            userEmail: email,
                            eventType: 'login_success',
                            action: 'Google Authentication',
                            status: 'success',
                            req: req,
                            details: { message: `User logged in successfully with role: ${role}` }
                        });

                        const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
                        res.cookie('token', token, {
                            httpOnly: true,
                            secure: isHttps,
                            sameSite: 'lax',
                            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
                        });

                        const hydratedPdp = ztaPdpService.hydrateAllPolicies(rbacPolicies);
                        const widgetLevels = {};
                        const podScopes = {};
                        for (const w of pluginManager.WIDGET_CATALOG) {
                            if (isAdmin) {
                                widgetLevels[w.id] = 'manage';
                            } else {
                                let bestRank = 0;
                                let bestLevel = 'none';
                                for (const r of roles) {
                                    const lvl = hydratedPdp[r]?.v2_matrix?.[w.id]?.level || 'none';
                                    const rnk = ztaPdpService.LEVEL_RANK[lvl] || 0;
                                    if (rnk > bestRank) {
                                        bestRank = rnk;
                                        bestLevel = lvl;
                                    }
                                }
                                widgetLevels[w.id] = bestLevel;
                            }
                        }
                        for (const r of roles) {
                            const pScopes = hydratedPdp[r]?.pod_scopes || {};
                            for (const [pId, pPerm] of Object.entries(pScopes)) {
                                if (pPerm === 'manage' || pPerm === 'write') {
                                    podScopes[pId] = 'write';
                                } else if (pPerm === 'read' && !podScopes[pId]) {
                                    podScopes[pId] = 'read';
                                }
                            }
                        }

                        db.get("SELECT * FROM users WHERE id = ?", [userId], (err, finalUser) => {
                            if (err || !finalUser) {
                                return res.json({ user: { id: userId, googleId, email, name, role, allowed_widgets, allowed_actions, allowed_models, widget_levels: widgetLevels, pod_scopes: isAdmin ? { '*': 'write' } : podScopes } });
                            }
                            // Also set the allowed sets for the frontend
                            finalUser.allowed_widgets = allowed_widgets;
                            finalUser.allowed_actions = allowed_actions;
                            finalUser.allowed_models = allowed_models;
                            finalUser.widget_levels = widgetLevels;
                            finalUser.pod_scopes = isAdmin ? { '*': 'write' } : podScopes;
                            res.json({ user: finalUser });
                        });
                    }
                );
            };

            // Check if there are any active admin users in the system
            db.get("SELECT COUNT(*) as adminCount FROM users WHERE role LIKE '%admin%'", [], async (adminErr, adminResult) => {
                if (adminErr) return res.status(500).json({ error: 'Database error' });
                const hasAdmin = Number(adminResult?.adminCount || 0) > 0;

                if (existingUser) {
                    // If no admin exists in the system yet, promote this existing user to admin
                    if (!hasAdmin) {
                        await db.setSetting('ACTIVATION_COMPLETED', 'true');
                        proceedWithLogin('admin');
                    } else {
                        proceedWithLogin(existingUser.role || 'user');
                    }
                } else {
                    // If no admin exists in the system, the very first user MUST be admin
                    if (!hasAdmin) {
                        await db.setSetting('ACTIVATION_COMPLETED', 'true');
                        proceedWithLogin('admin');
                    } else {
                        // Not the first admin. Check if they are invited.
                        db.get("SELECT email, created_at FROM invitations WHERE email = ?", [email], (err, invite) => {
                            if (err) return res.status(500).json({ error: 'Database error' });
                            
                            if (invite) {
                                // Enforce 3-day expiration limit
                                const inviteDate = new Date(invite.created_at + 'Z'); // SQLite CURRENT_TIMESTAMP is UTC
                                const now = new Date();
                                const diffDays = (now - inviteDate) / (1000 * 60 * 60 * 24);
                                
                                if (diffDays <= 3) {
                                    proceedWithLogin('user');
                                } else {
                                    console.log(`Login Rejected: ${email} invitation has expired.`);
                                    auditDb.logEvent({
                                        userId: null,
                                        userEmail: email,
                                        eventType: 'login_failed',
                                        action: 'Google Authentication',
                                        status: 'failure',
                                        req: req,
                                        details: { error: 'Invitation expired' }
                                    });
                                    res.status(403).json({ error: 'Your invitation has expired (valid for 3 days). Please ask the administrator to invite you again.' });
                                }
                            } else {
                                console.log(`Login Rejected: ${email} is not invited.`);
                                auditDb.logEvent({
                                    userId: null,
                                    userEmail: email,
                                    eventType: 'login_failed',
                                    action: 'Google Authentication',
                                    status: 'failure',
                                    req: req,
                                    details: { error: 'Not invited' }
                                });
                                res.status(403).json({ error: 'Access denied. You need an invitation from an administrator to access this workspace.' });
                            }
                        });
                    }
                }
            });
        });
    } catch (error) {
        console.error('Auth Error:', error);
        auditDb.logEvent({
            userId: null,
            userEmail: req.body?.email || null,
            eventType: 'login_failed',
            action: 'Google Authentication',
            status: 'failure',
            req: req,
            details: { error: error.message }
        });
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Local Dev / Container Quick Login (strictly restricted to localhost requests)
app.post('/api/auth/local-dev-login', async (req, res) => {
    const reqHost = (req.headers.host || req.hostname || '').split(':')[0];
    if (reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
        return res.status(403).json({ error: 'Local dev login is only available on localhost.' });
    }
    try {
        db.get("SELECT * FROM users WHERE role LIKE '%admin%' ORDER BY id ASC LIMIT 1", [], async (err, adminUser) => {
            if (err || !adminUser) {
                return res.status(404).json({ error: '管理者ユーザーがDBに存在しません。Googleログインを実行してください。' });
            }
            const nowIso = new Date().toISOString();
            db.run("UPDATE users SET last_active_at = ?, status_text = 'Active' WHERE id = ?", [nowIso, adminUser.id]);

            const widgetLevels = {};
            for (const w of pluginManager.WIDGET_CATALOG) {
                widgetLevels[w.id] = 'manage';
            }
            const hashes = getContextHashes(req);
            const token = jwt.sign(
                {
                    id: adminUser.id,
                    googleId: adminUser.google_id,
                    email: adminUser.email,
                    name: adminUser.name,
                    role: adminUser.role,
                    allowed_widgets: ['*'],
                    allowed_actions: ['*'],
                    allowed_models: ['*'],
                    allowed_pods: ['*'],
                    ip_hash: hashes.ipHash,
                    ua_hash: hashes.uaHash
                },
                process.env.JWT_SECRET || 'secret',
                { expiresIn: '7d' }
            );
            res.cookie('token', token, getSessionCookieOptions(req));
            res.json({
                user: {
                    ...adminUser,
                    last_active_at: nowIso,
                    status_text: 'Active',
                    allowed_widgets: ['*'],
                    allowed_actions: ['*'],
                    allowed_models: ['*'],
                    allowed_pods: ['*'],
                    widget_levels: widgetLevels,
                    pod_scopes: { '*': 'write' }
                }
            });
        });
    } catch (error) {
        console.error('Local Dev Login Error:', error);
        res.status(500).json({ error: 'Local dev login failed' });
    }
});



// Auth: Check login status
app.get('/api/auth/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated', code: 'SESSION_EXPIRED' });

    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) {
            try {
                const expiredDecoded = jwt.decode(token);
                if (expiredDecoded && expiredDecoded.id) {
                    db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [expiredDecoded.id]);
                    auditDb.logEvent({
                        userId: expiredDecoded.id,
                        userEmail: expiredDecoded.email,
                        eventType: 'session_timeout',
                        action: 'ZTA JWT Token Expired (/api/auth/me)',
                        status: 'blocked',
                        req: req,
                        details: { reason: 'jwt_expired' }
                    });
                }
            } catch (_) {}
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Invalid or expired token', code: 'SESSION_EXPIRED' });
        }

        // ZTA動的コンテキスト検証 (セッションハイジャック・タイムアウト防止)
        const hashes = getContextHashes(req);
        const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
        if (!isContextValid) {
            if (decoded && decoded.id) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
            }
            auditDb.logEvent({
                userId: decoded.id,
                userEmail: decoded.email,
                eventType: 'session_hijacking_detected',
                action: `${req.method} ${req.originalUrl}`,
                status: 'blocked',
                req: req,
                details: {
                    expectedIpHash: decoded.ip_hash,
                    gotIpHash: hashes.ipHash,
                    expectedUaHash: decoded.ua_hash,
                    gotUaHash: hashes.uaHash,
                    clientIp: hashes.ip,
                    userAgent: hashes.ua
                }
            });
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Session context mismatch. Security policy requires re-authentication.', code: 'SESSION_EXPIRED' });
        }

        db.get("SELECT * FROM users WHERE id = ?", [decoded.id], async (dbErr, user) => {
            if (!dbErr && user) {
                const maxLockCount = await getSessionLockMaxCount();
                const hardLogoutTimeoutMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;

                // ZTA セッション完全終了判定 (明示的ログアウト済 or 強制ログアウト済)
                if (!user.last_active_at) {
                    clearSessionCookie(req, res);
                    return res.status(401).json({
                        error: 'Session has been terminated. Please sign in again.',
                        code: 'SESSION_EXPIRED'
                    });
                }

                const lastActiveMs = new Date(user.last_active_at).getTime();
                const idleMs = Date.now() - lastActiveMs;

                // 30分 × maxLockCount 回（デフォルト6回＝3時間）を超過した場合は完全強制ログアウト
                if (isNaN(lastActiveMs) || idleMs >= hardLogoutTimeoutMs) {
                    db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [user.id]);
                    auditDb.logEvent({
                        userId: user.id,
                        userEmail: user.email,
                        eventType: 'session_timeout',
                        action: `ZTA Forced Logout (${maxLockCount} Idle Cycles Exceeded - /api/auth/me)`,
                        status: 'blocked',
                        req: req,
                        details: {
                            reason: 'max_lock_cycles_exceeded',
                            lastActiveAt: user.last_active_at,
                            idleMinutes: Math.round(idleMs / 60000),
                            maxLockCount,
                            idleTimeoutMinutesPerCycle: SESSION_IDLE_TIMEOUT_MS / 60000
                        }
                    });
                    clearSessionCookie(req, res);
                    return res.status(401).json({
                        error: 'Session idle timeout exceeded maximum lock cycles. Please sign in again.',
                        code: 'SESSION_EXPIRED'
                    });
                }

                // 30分以上（かつ最大回数未満）無操作、または既にソフトロック(Offline)状態の場合はソフトロック状態を維持
                const isSoftLocked = idleMs >= SESSION_IDLE_TIMEOUT_MS || (user.status_text || '').toLowerCase() === 'offline';
                const lockCount = isSoftLocked
                    ? Math.min(maxLockCount, Math.max(1, Math.floor(idleMs / SESSION_IDLE_TIMEOUT_MS) || 1))
                    : 0;

                if (isSoftLocked) {
                    if ((user.status_text || '').toLowerCase() !== 'offline') {
                        user.status_text = 'Offline';
                        db.run("UPDATE users SET status_text = 'Offline' WHERE id = ?", [user.id]);
                        auditDb.logEvent({
                            userId: user.id,
                            userEmail: user.email,
                            eventType: 'session_timeout',
                            action: `ZTA Session Soft Lock (Cycle ${lockCount}/${maxLockCount} - /api/auth/me)`,
                            status: 'success',
                            req: req,
                            details: {
                                reason: 'server_soft_lock',
                                lockCount,
                                maxLockCount,
                                lastActiveAt: user.last_active_at,
                                idleMinutes: Math.round(idleMs / 60000)
                            }
                        });
                    }
                } else if (req.query.active === '1') {
                    // ソフトロック中でない通常時のみ、ユーザーの実操作があった場合に last_active_at を更新する
                    const nowIso = new Date().toISOString();
                    user.last_active_at = nowIso;
                    db.run("UPDATE users SET last_active_at = ? WHERE id = ?", [nowIso, user.id]);
                }

                // Fetch fresh RBAC policies to act as a dynamic PEP
                let rbacPolicies = {};
                try {
                    const rbacJson = await db.getSetting('RBAC_POLICIES');
                    if (rbacJson) rbacPolicies = JSON.parse(rbacJson);
                } catch (e) {
                    console.error("Failed to fetch RBAC_POLICIES in /api/auth/me", e);
                }

                const roles = (user.role || 'user').split(',').map(r => r.trim());
                let allowed_widgets_set = new Set();
                let allowed_actions_set = new Set();
                let allowed_models_set = new Set();
                let allowed_pods_set = new Set();
                let hasWildcardModels = false;

                roles.forEach(r => {
                    const policy = rbacPolicies[r] || rbacPolicies['user'] || {};
                    (policy.allowed_widgets || []).forEach(w => allowed_widgets_set.add(w));
                    (policy.allowed_actions || []).forEach(a => allowed_actions_set.add(a));
                    (policy.allowed_pods || []).forEach(p => allowed_pods_set.add(p));
                    (policy.allowed_models || []).forEach(m => {
                        if (m === '*') hasWildcardModels = true;
                        allowed_models_set.add(m);
                    });
                });

                // Enforce Universal Default Widgets for profile management
                ['app:settings'].forEach(w => allowed_widgets_set.add(w));

                const isAdmin = roles.includes('admin');
                user.allowed_widgets = (isAdmin || allowed_widgets_set.has('*')) ? ['*'] : Array.from(allowed_widgets_set);
                user.allowed_actions = (isAdmin || allowed_actions_set.has('*')) ? ['*'] : Array.from(allowed_actions_set);
                user.allowed_models = (isAdmin || hasWildcardModels) ? ['*'] : Array.from(allowed_models_set);
                user.allowed_pods = (isAdmin || allowed_pods_set.has('*')) ? ['*'] : Array.from(allowed_pods_set);

                // Evaluate 3D ZTA PDP widget permission levels (none | read | execute | manage) and pod scopes
                const hydratedPdp = ztaPdpService.hydrateAllPolicies(rbacPolicies);
                const widgetLevels = {};
                const podScopes = {};
                for (const w of pluginManager.WIDGET_CATALOG) {
                    if (isAdmin) {
                        widgetLevels[w.id] = 'manage';
                    } else {
                        let bestRank = 0;
                        let bestLevel = 'none';
                        for (const r of roles) {
                            const lvl = hydratedPdp[r]?.v2_matrix?.[w.id]?.level || 'none';
                            const rnk = ztaPdpService.LEVEL_RANK[lvl] || 0;
                            if (rnk > bestRank) {
                                bestRank = rnk;
                                bestLevel = lvl;
                            }
                        }
                        widgetLevels[w.id] = bestLevel;
                    }
                }
                for (const r of roles) {
                    const pScopes = hydratedPdp[r]?.pod_scopes || {};
                    for (const [pId, pPerm] of Object.entries(pScopes)) {
                        if (pPerm === 'manage' || pPerm === 'write') {
                            podScopes[pId] = 'write';
                        } else if (pPerm === 'read' && !podScopes[pId]) {
                            podScopes[pId] = 'read';
                        }
                    }
                }
                user.widget_levels = widgetLevels;
                user.pod_scopes = isAdmin ? { '*': 'write' } : podScopes;

                // Re-issue JWT to ensure subsequent API calls (PEP) succeed with fresh permissions
                const newToken = jwt.sign(
                    { 
                        id: user.id, 
                        googleId: user.google_id, 
                        email: user.email, 
                        name: user.name, 
                        role: user.role, 
                        allowed_widgets: user.allowed_widgets, 
                        allowed_actions: user.allowed_actions, 
                        allowed_models: user.allowed_models,
                        allowed_pods: user.allowed_pods,
                        ip_hash: hashes.ipHash,
                        ua_hash: hashes.uaHash
                    },
                    process.env.JWT_SECRET || 'secret',
                    { expiresIn: '7d' }
                );
                const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
                res.cookie('token', newToken, {
                    httpOnly: true,
                    secure: isHttps,
                    sameSite: 'lax',
                    maxAge: 7 * 24 * 60 * 60 * 1000
                });

                res.json({
                    user,
                    sessionLocked: isSoftLocked,
                    lockCount,
                    maxLockCount,
                    lastActiveAt: user.last_active_at
                });
            } else {
                clearSessionCookie(req, res);
                res.status(401).json({ error: 'User not found in database', code: 'SESSION_EXPIRED' });
            }
        });
    });
});

// Auth: Logout (Manual Logout & ZTA Session Idle Timeout)
app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies.token;
    const body = req.body || {};
    const isSessionTimeout = body.reason === 'session_timeout';

    const finishLogout = () => {
        clearSessionCookie(req, res);
        res.json({ message: isSessionTimeout ? 'Session timed out' : 'Logged out' });
    };

    if (!token) {
        return finishLogout();
    }

    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        const payload = (!err && decoded) ? decoded : jwt.decode(token);
        if (payload && payload.id) {
            // もし別ブラウザの古い未リロードタブから旧式の30分自動ログアウト(lockCycles未指定)が送信された場合、
            // 規定回数(maxLockCount)に達していなければ last_active_at を消去せずソフトロックとして保護する
            if (isSessionTimeout && !body.lockCycles) {
                db.get("SELECT id, email, last_active_at FROM users WHERE id = ?", [payload.id], async (uErr, uRow) => {
                    const maxLockCount = await getSessionLockMaxCount();
                    const hardLogoutMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;
                    const lastMs = uRow?.last_active_at ? new Date(uRow.last_active_at).getTime() : 0;
                    if (uRow && lastMs && (Date.now() - lastMs < hardLogoutMs)) {
                        clearSessionCookie(req, res);
                        return res.json({ message: 'Legacy tab session cleared without terminating active account state' });
                    }
                    db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [payload.id], () => {
                        finishLogout();
                    });
                });
                return;
            }

            db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [payload.id], () => {
                auditDb.logEvent({
                    userId: payload.id,
                    userEmail: payload.email,
                    eventType: isSessionTimeout ? 'session_timeout' : 'logout',
                    action: isSessionTimeout ? 'ZTA Session Idle Timeout (Auto Logout)' : 'Logout',
                    status: 'success',
                    req: req,
                    details: isSessionTimeout ? {
                        reason: 'client_idle_timeout',
                        idleMinutes: body.idleMinutes || (SESSION_IDLE_TIMEOUT_MS / 60000),
                        lockCycles: body.lockCycles || null,
                        trigger: body.trigger || 'ui_idle_monitor',
                        message: body.message || 'Session terminated due to inactivity under ZTA policy'
                    } : null
                });
                finishLogout();
            });
        } else {
            finishLogout();
        }
    });
});

// Middleware that validates JWT & ZTA context and allows Soft-Locked sessions (for Lock/Unlock/Passkey endpoints)
function requireAuthAllowLocked(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated', code: 'SESSION_EXPIRED' });
    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) {
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Invalid or expired token', code: 'SESSION_EXPIRED' });
        }
        const hashes = getContextHashes(req);
        const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
        if (!isContextValid) {
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Session context mismatch', code: 'SESSION_EXPIRED' });
        }
        db.get("SELECT * FROM users WHERE id = ?", [decoded.id], async (dbErr, row) => {
            if (dbErr || !row || !row.last_active_at) {
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'SESSION_EXPIRED' });
            }
            const maxLockCount = await getSessionLockMaxCount();
            const hardLogoutTimeoutMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;
            const lastActiveMs = new Date(row.last_active_at).getTime();
            if (isNaN(lastActiveMs) || (Date.now() - lastActiveMs >= hardLogoutTimeoutMs)) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Maximum session lock duration exceeded. Please sign in again.', code: 'SESSION_EXPIRED' });
            }
            req.user = decoded;
            req.userRow = row;
            req.maxLockCount = maxLockCount;
            next();
        });
    });
}

// Auth: Soft Lock Session (30-min idle cycle notification without destroying UI session)
app.post('/api/auth/session-lock', requireAuthAllowLocked, (req, res) => {
    const userRow = req.userRow;
    const maxLockCount = req.maxLockCount;
    const body = req.body || {};
    const lastActiveMs = new Date(userRow.last_active_at).getTime();
    const idleMs = Math.max(0, Date.now() - lastActiveMs);
    const computedCycle = Math.max(1, Number(body.lockCycle) || Math.floor(idleMs / SESSION_IDLE_TIMEOUT_MS) || 1);

    if (computedCycle >= maxLockCount) {
        db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [userRow.id], () => {
            auditDb.logEvent({
                userId: userRow.id,
                userEmail: userRow.email,
                eventType: 'session_timeout',
                action: `ZTA Forced Logout (${computedCycle}/${maxLockCount} Idle Cycles Reached)`,
                status: 'success',
                req: req,
                details: {
                    reason: 'max_lock_cycles_exceeded',
                    lockCycle: computedCycle,
                    maxLockCount,
                    idleMinutes: Math.round(idleMs / 60000)
                }
            });
            clearSessionCookie(req, res);
            return res.status(401).json({
                error: 'Maximum idle lock cycles reached. Forced logout.',
                code: 'SESSION_EXPIRED',
                lockCount: computedCycle,
                maxLockCount
            });
        });
        return;
    }

    // Keep last_active_at intact so total idle time continues to accumulate across 30m cycles,
    // and transition Virtual Office presence to Offline.
    db.run("UPDATE users SET status_text = 'Offline' WHERE id = ?", [userRow.id], () => {
        auditDb.logEvent({
            userId: userRow.id,
            userEmail: userRow.email,
            eventType: 'session_timeout',
            action: `ZTA Session Soft Lock (Cycle ${computedCycle}/${maxLockCount})`,
            status: 'success',
            req: req,
            details: {
                reason: 'session_soft_lock',
                lockCycle: computedCycle,
                maxLockCount,
                idleMinutes: body.idleMinutes || (computedCycle * (SESSION_IDLE_TIMEOUT_MS / 60000)),
                lastActiveAt: userRow.last_active_at
            }
        });
        db.all("SELECT id, device_name, created_at, last_used_at FROM user_passkeys WHERE user_id = ?", [userRow.id], (pkErr, pks) => {
            res.json({
                locked: true,
                lockCount: computedCycle,
                maxLockCount,
                lastActiveAt: userRow.last_active_at,
                hasPasskeys: Array.isArray(pks) && pks.length > 0
            });
        });
    });
});

// Helper to build unlocked user payload with RBAC permissions
async function buildUnlockedUserPayload(userRow) {
    let rbacPolicies;
    try {
        rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
    } catch (e) {
        rbacPolicies = {};
    }
    const roles = (userRow.role || 'user').split(',').map(r => r.trim());
    const allowed_widgets_set = new Set();
    const allowed_actions_set = new Set();
    const allowed_pods_set = new Set();
    let hasWildcardModels = false;
    const allowed_models_set = new Set();
    roles.forEach(r => {
        const policy = rbacPolicies[r] || rbacPolicies['user'] || {};
        (policy.allowed_widgets || []).forEach(w => allowed_widgets_set.add(w));
        (policy.allowed_actions || []).forEach(a => allowed_actions_set.add(a));
        (policy.allowed_pods || []).forEach(p => allowed_pods_set.add(p));
        (policy.allowed_models || []).forEach(m => {
            if (m === '*') hasWildcardModels = true;
            allowed_models_set.add(m);
        });
    });
    ['app:settings'].forEach(w => allowed_widgets_set.add(w));
    const isAdmin = roles.includes('admin');
    return {
        ...userRow,
        allowed_widgets: (isAdmin || allowed_widgets_set.has('*')) ? ['*'] : Array.from(allowed_widgets_set),
        allowed_actions: (isAdmin || allowed_actions_set.has('*')) ? ['*'] : Array.from(allowed_actions_set),
        allowed_models: (isAdmin || hasWildcardModels) ? ['*'] : Array.from(allowed_models_set),
        allowed_pods: (isAdmin || allowed_pods_set.has('*')) ? ['*'] : Array.from(allowed_pods_set)
    };
}

// Auth: Unlock Soft-Locked Session via in-UI Google Re-authentication
app.post('/api/auth/unlock-google', requireAuthAllowLocked, async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });

    try {
        const oAuth2Client = await getOAuthClient();
        if (!oAuth2Client) {
            return res.status(500).json({ error: 'Server OAuth configuration missing' });
        }

        const { tokens } = await oAuth2Client.getToken(code);
        const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID;
        const ticket = await oAuth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: clientId
        });
        const payload = ticket.getPayload();
        const { sub: googleId, email } = payload;

        const userRow = req.userRow;
        const isSameUser = (userRow.google_id && userRow.google_id === googleId) ||
            (userRow.email && email && userRow.email.toLowerCase() === email.toLowerCase());

        if (!isSameUser) {
            auditDb.logEvent({
                userId: userRow.id,
                userEmail: userRow.email,
                eventType: 'login_failed',
                action: 'ZTA Session Unlock Failed (Account Mismatch)',
                status: 'blocked',
                req: req,
                details: { expectedEmail: userRow.email, attemptedEmail: email }
            });
            return res.status(403).json({
                error: `現在ロック中のアカウント（${userRow.email}）と同じGoogleアカウントで認証してください。`
            });
        }

        const nowIso = new Date().toISOString();
        const onlineStatus = getDefaultOnlineStatusText(userRow);
        db.run("UPDATE users SET status_text = ?, last_active_at = ? WHERE id = ?", [onlineStatus, nowIso, userRow.id], async () => {
            const updatedUser = await buildUnlockedUserPayload({
                ...userRow,
                status_text: onlineStatus,
                last_active_at: nowIso
            });
            const hashes = getContextHashes(req);
            const sessionToken = jwt.sign(
                {
                    id: userRow.id,
                    googleId: userRow.google_id,
                    email: userRow.email,
                    name: userRow.name,
                    role: userRow.role,
                    allowed_widgets: updatedUser.allowed_widgets,
                    allowed_actions: updatedUser.allowed_actions,
                    allowed_models: updatedUser.allowed_models,
                    allowed_pods: updatedUser.allowed_pods,
                    ip_hash: hashes.ipHash,
                    ua_hash: hashes.uaHash
                },
                process.env.JWT_SECRET || 'secret',
                { expiresIn: '7d' }
            );
            res.cookie('token', sessionToken, getSessionCookieOptions(req, 7 * 24 * 60 * 60 * 1000));

            auditDb.logEvent({
                userId: userRow.id,
                userEmail: userRow.email,
                eventType: 'login_success',
                action: 'ZTA Session Unlocked (Google Re-authentication)',
                status: 'success',
                req: req,
                details: { method: 'google_oauth_in_ui' }
            });

            res.json({ success: true, user: updatedUser });
        });
    } catch (error) {
        console.error('[ZTA Unlock Google Error]:', error);
        res.status(401).json({ error: 'Google再認証に失敗しました。もう一度お試しください。' });
    }
});

// ==========================================
// Auth: WebAuthn Passkey Endpoints (ZTA Re-authentication & Registration)
// ==========================================

// List registered passkeys for current user
app.get('/api/auth/passkey/list', requireAuthAllowLocked, (req, res) => {
    db.all(
        "SELECT id, credential_id, device_name, transports, created_at, last_used_at FROM user_passkeys WHERE user_id = ? ORDER BY created_at DESC",
        [req.userRow.id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ passkeys: rows || [] });
        }
    );
});

// Delete a passkey
app.delete('/api/auth/passkey/:id', requireAuth, (req, res) => {
    const passkeyId = req.params.id;
    db.run("DELETE FROM user_passkeys WHERE id = ? AND user_id = ?", [passkeyId, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Generate WebAuthn registration options (PublicKeyCredentialCreationOptions)
app.post('/api/auth/passkey/register/options', requireAuthAllowLocked, (req, res) => {
    const userRow = req.userRow;
    const rpId = getRpId(req);
    const challenge = crypto.randomBytes(32).toString('base64url');
    saveWebauthnChallenge(userRow.id, challenge, 'create');

    db.all("SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?", [userRow.id], (err, existingRows) => {
        if (err) return res.status(500).json({ error: err.message });

        const excludeCredentials = (existingRows || []).map(row => {
            let transports = ['internal', 'hybrid'];
            try {
                if (row.transports) transports = JSON.parse(row.transports);
            } catch (_) {}
            return {
                id: row.credential_id,
                type: 'public-key',
                transports
            };
        });

        const userIdBase64Url = Buffer.from(String(userRow.id), 'utf8').toString('base64url');
        res.json({
            rp: {
                name: 'Multi Agent System (ZTA)',
                id: rpId
            },
            user: {
                id: userIdBase64Url,
                name: userRow.email || `user-${userRow.id}`,
                displayName: userRow.display_name || userRow.name || userRow.email || `User ${userRow.id}`
            },
            challenge,
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },   // ES256
                { type: 'public-key', alg: -257 }  // RS256
            ],
            timeout: 120000,
            excludeCredentials,
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
                residentKey: 'preferred',
                userVerification: 'required'
            },
            attestation: 'none'
        });
    });
});

// Verify WebAuthn registration response and store SPKI public key
app.post('/api/auth/passkey/register/verify', requireAuthAllowLocked, async (req, res) => {
    const userRow = req.userRow;
    const { credential, publicKeySpki, publicKeyAlg, deviceName } = req.body || {};
    if (!credential || !credential.id || !credential.response || !publicKeySpki) {
        return res.status(400).json({ error: 'Invalid passkey registration payload' });
    }

    const expectedChallenge = consumeWebauthnChallenge(userRow.id, 'create');
    if (!expectedChallenge) {
        return res.status(400).json({ error: 'Registration challenge expired or not found. Please try again.' });
    }

    try {
        const clientDataBuf = Buffer.from(credential.response.clientDataJSON, 'base64url');
        const clientData = JSON.parse(clientDataBuf.toString('utf8'));

        if (clientData.type !== 'webauthn.create') {
            return res.status(400).json({ error: 'Invalid clientData.type' });
        }
        if (clientData.challenge !== expectedChallenge) {
            return res.status(400).json({ error: 'Challenge mismatch' });
        }
        const expectedOrigins = getExpectedOrigins(req);
        if (!expectedOrigins.includes(clientData.origin)) {
            return res.status(400).json({ error: `Origin mismatch: ${clientData.origin}` });
        }

        // Verify RP ID hash and User Present (UP) flag in authenticatorData if provided
        let signCount = 0;
        if (credential.response.authenticatorData) {
            const authDataBuf = Buffer.from(credential.response.authenticatorData, 'base64url');
            if (authDataBuf.length < 37) {
                return res.status(400).json({ error: 'Invalid authenticatorData length' });
            }
            const rpIdHash = authDataBuf.subarray(0, 32);
            const expectedRpIdHash = crypto.createHash('sha256').update(getRpId(req)).digest();
            if (!rpIdHash.equals(expectedRpIdHash)) {
                return res.status(400).json({ error: 'RP ID hash mismatch' });
            }
            const flags = authDataBuf[32];
            const userPresent = (flags & 0x01) !== 0;
            if (!userPresent) {
                return res.status(400).json({ error: 'User Present (UP) flag is required' });
            }
            signCount = authDataBuf.readUInt32BE(33);
        }

        // Validate that publicKeySpki is a valid SPKI key parseable by Node crypto
        const spkiBuf = Buffer.from(publicKeySpki, 'base64url');
        crypto.createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });

        const transports = JSON.stringify(credential.response.transports || ['internal']);
        const label = (deviceName || 'Mac / Platform Passkey').slice(0, 80);

        db.run(
            `INSERT INTO user_passkeys (user_id, credential_id, public_key, algorithm, sign_count, transports, device_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userRow.id, credential.id, publicKeySpki, Number(publicKeyAlg) || -7, signCount, transports, label],
            async function(dbErr) {
                if (dbErr) {
                    console.error('[Passkey Register DB Error]:', dbErr);
                    return res.status(500).json({ error: 'Failed to store passkey credential' });
                }

                // If session was locked when registering, also unlock it immediately
                const nowIso = new Date().toISOString();
                const onlineStatus = getDefaultOnlineStatusText(userRow);
                db.run("UPDATE users SET status_text = ?, last_active_at = ? WHERE id = ?", [onlineStatus, nowIso, userRow.id], async () => {
                    auditDb.logEvent({
                        userId: userRow.id,
                        userEmail: userRow.email,
                        eventType: 'passkey_registered',
                        action: `ZTA Passkey Registered (${label})`,
                        status: 'success',
                        req: req,
                        details: { credentialId: credential.id, deviceName: label }
                    });
                    const updatedUser = await buildUnlockedUserPayload({
                        ...userRow,
                        status_text: onlineStatus,
                        last_active_at: nowIso
                    });
                    res.json({ success: true, user: updatedUser });
                });
            }
        );
    } catch (verifyErr) {
        console.error('[Passkey Register Verify Error]:', verifyErr);
        return res.status(400).json({ error: 'Passkey verification failed: ' + verifyErr.message });
    }
});

// Generate WebAuthn assertion options for re-authentication (allowCredentials strictly scoped to signed-in user)
app.post('/api/auth/passkey/reauth/options', requireAuthAllowLocked, (req, res) => {
    const userRow = req.userRow;
    const rpId = getRpId(req);

    db.all("SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?", [userRow.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows || rows.length === 0) {
            return res.status(404).json({
                error: 'このアカウントにはまだパスキーが登録されていません。',
                code: 'NO_PASSKEYS_REGISTERED'
            });
        }

        const challenge = crypto.randomBytes(32).toString('base64url');
        saveWebauthnChallenge(userRow.id, challenge, 'get');

        const allowCredentials = rows.map(row => {
            let transports = ['internal', 'hybrid'];
            try {
                if (row.transports) transports = JSON.parse(row.transports);
            } catch (_) {}
            return {
                type: 'public-key',
                id: row.credential_id,
                transports
            };
        });

        res.json({
            challenge,
            rpId,
            timeout: 120000,
            userVerification: 'required',
            allowCredentials
        });
    });
});

// Verify WebAuthn assertion and unlock Soft-Locked session
app.post('/api/auth/passkey/reauth/verify', requireAuthAllowLocked, async (req, res) => {
    const userRow = req.userRow;
    const { credential } = req.body || {};
    if (!credential || !credential.id || !credential.response) {
        return res.status(400).json({ error: 'Invalid assertion payload' });
    }

    const expectedChallenge = consumeWebauthnChallenge(userRow.id, 'get');
    if (!expectedChallenge) {
        return res.status(400).json({ error: 'Authentication challenge expired. Please try again.' });
    }

    db.get("SELECT * FROM user_passkeys WHERE credential_id = ?", [credential.id], (err, storedCred) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!storedCred) {
            return res.status(404).json({
                error: '指定されたパスキーが見つかりません。',
                code: 'CREDENTIAL_NOT_FOUND',
                credentialId: credential.id
            });
        }

        // Strict account ownership check (prevent cross-account assertion acceptance)
        if (Number(storedCred.user_id) !== Number(userRow.id)) {
            auditDb.logEvent({
                userId: userRow.id,
                userEmail: userRow.email,
                eventType: 'login_failed',
                action: 'ZTA Passkey Unlock Blocked (Account Ownership Mismatch)',
                status: 'blocked',
                req: req,
                details: { credentialId: credential.id }
            });
            return res.status(403).json({ error: 'Account ownership mismatch for this passkey.' });
        }

        try {
            const clientDataBuf = Buffer.from(credential.response.clientDataJSON, 'base64url');
            const authDataBuf = Buffer.from(credential.response.authenticatorData, 'base64url');
            const signatureBuf = Buffer.from(credential.response.signature, 'base64url');

            const clientData = JSON.parse(clientDataBuf.toString('utf8'));
            if (clientData.type !== 'webauthn.get') {
                return res.status(400).json({ error: 'Invalid clientData.type' });
            }
            if (clientData.challenge !== expectedChallenge) {
                return res.status(400).json({ error: 'Challenge mismatch' });
            }
            const expectedOrigins = getExpectedOrigins(req);
            if (!expectedOrigins.includes(clientData.origin)) {
                return res.status(400).json({ error: `Origin mismatch: ${clientData.origin}` });
            }

            if (authDataBuf.length < 37) {
                return res.status(400).json({ error: 'Invalid authenticatorData' });
            }
            const rpIdHash = authDataBuf.subarray(0, 32);
            const expectedRpIdHash = crypto.createHash('sha256').update(getRpId(req)).digest();
            if (!rpIdHash.equals(expectedRpIdHash)) {
                return res.status(400).json({ error: 'RP ID hash mismatch' });
            }

            const flags = authDataBuf[32];
            const userPresent = (flags & 0x01) !== 0;
            if (!userPresent) {
                return res.status(400).json({ error: 'User Present (UP) flag not set' });
            }

            const newSignCount = authDataBuf.readUInt32BE(33);
            if (newSignCount > 0 && storedCred.sign_count > 0 && newSignCount <= storedCred.sign_count) {
                return res.status(400).json({ error: 'Passkey signature counter anomaly detected' });
            }

            // Verify cryptographic signature over authenticatorData || SHA256(clientDataJSON)
            const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
            const signedData = Buffer.concat([authDataBuf, clientDataHash]);
            const publicKeyObj = crypto.createPublicKey({
                key: Buffer.from(storedCred.public_key, 'base64url'),
                format: 'der',
                type: 'spki'
            });

            const isSignatureValid = crypto.verify('sha256', signedData, publicKeyObj, signatureBuf);
            if (!isSignatureValid) {
                return res.status(401).json({ error: 'Passkey cryptographic signature verification failed' });
            }

            const nowIso = new Date().toISOString();
            const onlineStatus = getDefaultOnlineStatusText(userRow);

            db.run("UPDATE user_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?", [newSignCount, nowIso, storedCred.id]);
            db.run("UPDATE users SET status_text = ?, last_active_at = ? WHERE id = ?", [onlineStatus, nowIso, userRow.id], async () => {
                const updatedUser = await buildUnlockedUserPayload({
                    ...userRow,
                    status_text: onlineStatus,
                    last_active_at: nowIso
                });
                const hashes = getContextHashes(req);
                const sessionToken = jwt.sign(
                    {
                        id: userRow.id,
                        googleId: userRow.google_id,
                        email: userRow.email,
                        name: userRow.name,
                        role: userRow.role,
                        allowed_widgets: updatedUser.allowed_widgets,
                        allowed_actions: updatedUser.allowed_actions,
                        allowed_models: updatedUser.allowed_models,
                        allowed_pods: updatedUser.allowed_pods,
                        ip_hash: hashes.ipHash,
                        ua_hash: hashes.uaHash
                    },
                    process.env.JWT_SECRET || 'secret',
                    { expiresIn: '7d' }
                );
                res.cookie('token', sessionToken, getSessionCookieOptions(req, 7 * 24 * 60 * 60 * 1000));

                auditDb.logEvent({
                    userId: userRow.id,
                    userEmail: userRow.email,
                    eventType: 'login_success',
                    action: `ZTA Session Unlocked (Passkey: ${storedCred.device_name || 'Platform'})`,
                    status: 'success',
                    req: req,
                    details: { method: 'webauthn_passkey', credentialId: storedCred.credential_id }
                });

                res.json({ success: true, user: updatedUser });
            });
        } catch (verifyErr) {
            console.error('[Passkey Reauth Verify Error]:', verifyErr);
            return res.status(400).json({ error: 'Passkey assertion verification failed: ' + verifyErr.message });
        }
    });
});

// Auth: Token Exchange (RFC 8693) & Client Credentials for Agent-to-Agent (A2A) authentication
app.post('/api/auth/token-exchange', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
    const body = req.body || {};
    const { grant_type, audience, client_id, client_secret } = body;
    
    if (!grant_type) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'grant_type is required' });
    }

    // 1. Client Credentials (A2A) Flow
    if (grant_type === 'client_credentials') {
        if (!audience) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'audience is required' });
        }
        
        // --- 🔒 マルチ・プロバイダー ZTA 認証チェック ---
        
        // A) ローカル専用の合言葉（フォールバック用）の確認
        const internalClientId = 'macos-ui-internal-client';
        const expectedSecret = process.env.DB_ENCRYPTION_KEY || 'development-encryption-key-123456';
        
        let isValidClient = (client_id === internalClientId && client_secret === expectedSecret);
        
        // B) 動的データベース（シークレット）照合
        if (!isValidClient) {
            try {
                const dbMatch = await new Promise((resolve, reject) => {
                    db.get("SELECT client_secret FROM mcp_servers WHERE client_id = ?", [client_id], (err, row) => {
                        if (err) return reject(err);
                        resolve(row);
                    });
                });

                if (dbMatch && dbMatch.client_secret) {
                    let decryptedSecret = null;
                    try {
                        decryptedSecret = decrypt(dbMatch.client_secret);
                    } catch (e) {
                        console.error("[Token Exchange] Decryption error for client_secret:", e);
                    }
                    
                    // 暗号・復号結果、または保存されている値そのもの(生の値)ともダブルチェックして一致を確認
                    const matchDecrypted = decryptedSecret && (client_secret === decryptedSecret);
                    const matchRaw = client_secret === dbMatch.client_secret;
                    
                    if (matchDecrypted || matchRaw) {
                        isValidClient = true;
                    } else {
                        // セキュリティを担保しつつ、トラブルシュートのためのログ出力 (生の値は伏字)
                        const obscure = (str) => {
                            if (!str) return "null";
                            return str.substring(0, 3) + "...(length:" + str.length + ")";
                        };
                        console.warn(`[Token Exchange] Credentials mismatch:
                          - Input Client ID: ${client_id}
                          - Input Client Secret (obscured): ${obscure(client_secret)}
                          - Decrypted Database Secret (obscured): ${obscure(decryptedSecret)}
                          - Raw Database Secret (obscured): ${obscure(dbMatch.client_secret)}
                        `);
                    }
                } else {
                    console.warn(`[Token Exchange] No matching client_id found in database for ID: ${client_id}`);
                }
            } catch (dbErr) {
                console.error("[Token Exchange] Database verification error:", dbErr);
            }
        }

        if (!isValidClient) {
            return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
        }
        
        // Issue a short-lived, downscoped Agent Token for internal service
        const agentToken = jwt.sign(
            { 
                sub: 'system-internal',
                email: 'system@macosui-internal.local',
                name: 'MacOSUI Internal Service',
                aud: audience,
                role: 'system',
                type: 'agent_token'
            },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '1h' }
        );
        
        return res.json({
            access_token: agentToken,
            issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            token_type: 'Bearer',
            expires_in: 3600
        });
    }

    // 2. Standard Token Exchange (RFC 8693) Flow - Requires active User Session
    if (grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (!audience) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'audience is required' });
    }

    // Inline requireAuth session validation
    let sessionToken = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        sessionToken = authHeader.substring(7);
    }
    if (!sessionToken) {
        sessionToken = req.cookies.token;
    }

    if (!sessionToken) {
        return res.status(401).json({ error: 'unauthorized', error_description: 'Session authentication required for token exchange' });
    }

    jwt.verify(sessionToken, process.env.JWT_SECRET || 'secret', async (err, decoded) => {
        if (err) {
            return res.status(401).json({ error: 'invalid_token', error_description: 'Invalid or expired session' });
        }

        // Check DB to make sure user still exists and get latest details
        db.get("SELECT role, native_language FROM users WHERE id = ?", [decoded.id], async (dbErr, row) => {
            if (dbErr || !row) {
                return res.status(401).json({ error: 'unauthorized', error_description: 'User not found' });
            }

            // Perform context validation if necessary (session hijacking check)
            const hashes = getContextHashes(req);
            const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
            if (!isContextValid) {
                return res.status(403).json({ error: 'access_denied', error_description: 'Session context mismatch' });
            }

            // Get user permissions and allowed widgets
            let rbacPolicies;
            try {
                rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
            } catch(e) {
                rbacPolicies = {};
            }
            
            const roles = (row.role || 'user').split(',').map(r => r.trim());
            const allowed_widgets_set = new Set();
            roles.forEach(roleName => {
                const policy = rbacPolicies[roleName] || {};
                const widgets = policy.allowed_widgets || [];
                widgets.forEach(w => allowed_widgets_set.add(w));
            });

            const allowedWidgets = Array.from(allowed_widgets_set);
            const hasAccess = allowedWidgets.includes('*') || allowedWidgets.includes(audience);
            
            if (!hasAccess) {
                return res.status(403).json({ error: 'access_denied', error_description: `User does not have access to audience: ${audience}` });
            }

            // Issue a short-lived, downscoped Agent Token
            const agentToken = jwt.sign(
                { 
                    sub: decoded.googleId || decoded.id,
                    email: decoded.email,
                    name: decoded.name,
                    aud: audience,
                    role: row.role,
                    type: 'agent_token'
                },
                process.env.JWT_SECRET || 'secret',
                { expiresIn: '1h' }
            );

            return res.json({
                access_token: agentToken,
                issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                token_type: 'Bearer',
                expires_in: 3600
            });
        });
    });
});

// Middleware to support both User sessions (Cookie) and Agent-to-Agent (Authorization Header or Query Parameter)
function requireAgentOrUserAuth(req, res, next) {
    let token = null;

    // 1. Try to extract token from Authorization Header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    // 2. Try to extract token from query parameter (for SSE GET requests)
    if (!token && req.query && req.query.access_token) {
        token = req.query.access_token;
    }

    // 3. Try to extract token from cookie
    if (!token) {
        token = req.cookies.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }

        // If it is an Agent-to-Agent (A2A) token
        if (decoded.type === 'agent_token') {
            // Verify if the token was issued for accessing this specific API resource.
            // Under our model, the audience (aud) for knowledge base MCP can be 'app:knowledge-base' or 'mcp:knowledge'
            const validAudiences = ['app:knowledge-base', 'mcp:knowledge', 'app:gemma', 'mcp:gemma', '*'];
            if (!validAudiences.includes(decoded.aud)) {
                return res.status(403).json({ error: 'Access denied. Invalid audience for agent token.' });
            }

            req.user = decoded;
            // No need to query database for agent tokens, as they are downscoped and transient.
            return next();
        }

        // Otherwise, it is a regular user session token.
        // Perform standard ZTA context check.
        const hashes = getContextHashes(req);
        const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
        if (!isContextValid) {
            if (decoded && decoded.id) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
            }
            auditDb.logEvent({
                userId: decoded.id,
                userEmail: decoded.email,
                eventType: 'session_hijacking_detected',
                action: `${req.method} ${req.originalUrl}`,
                status: 'blocked',
                req: req,
                details: { 
                    expectedIpHash: decoded.ip_hash, 
                    gotIpHash: hashes.ipHash, 
                    expectedUaHash: decoded.ua_hash, 
                    gotUaHash: hashes.uaHash,
                    clientIp: hashes.ip,
                    userAgent: hashes.ua
                }
            });
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Session context mismatch. Security policy requires re-authentication.', code: 'SESSION_EXPIRED' });
        }

        // RBAC dynamic policy lookup for user + ZTA session liveness check
        db.get("SELECT role, native_language, email, status_text, last_active_at FROM users WHERE id = ?", [decoded.id], async (err, row) => {
            if (err || !row) {
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'User not found in database', code: 'SESSION_EXPIRED' });
            }

            if (!row.last_active_at) {
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Session terminated. Please sign in again.', code: 'SESSION_EXPIRED' });
            }

            const maxLockCount = await getSessionLockMaxCount();
            const hardLogoutTimeoutMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;
            const lastActiveMs = new Date(row.last_active_at).getTime();
            const idleMs = isNaN(lastActiveMs) ? Infinity : (Date.now() - lastActiveMs);

            if (idleMs >= hardLogoutTimeoutMs) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
                auditDb.logEvent({
                    userId: decoded.id,
                    userEmail: row.email || decoded.email,
                    eventType: 'session_timeout',
                    action: `ZTA Server-Side Forced Logout (${req.method} ${req.originalUrl})`,
                    status: 'blocked',
                    req: req,
                    details: {
                        reason: 'max_lock_cycles_exceeded',
                        lastActiveAt: row.last_active_at,
                        maxLockCount,
                        idleTimeoutMinutes: Math.round(hardLogoutTimeoutMs / 60000)
                    }
                });
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Session idle timeout exceeded. Please sign in again.', code: 'SESSION_EXPIRED' });
            }

            const isSoftLocked = (row.status_text || '').toLowerCase() === 'offline' || (idleMs >= SESSION_IDLE_TIMEOUT_MS);
            if (isSoftLocked) {
                const lockCount = Math.max(1, Math.min(maxLockCount - 1, Math.floor(idleMs / SESSION_IDLE_TIMEOUT_MS) || 1));
                if ((row.status_text || '').toLowerCase() !== 'offline') {
                    db.run("UPDATE users SET status_text = 'Offline' WHERE id = ?", [decoded.id]);
                }
                return res.status(401).json({
                    error: 'Session is locked due to inactivity. Please re-authenticate to continue.',
                    code: 'SESSION_LOCKED',
                    lockCount,
                    maxLockCount,
                    lastActiveAt: row.last_active_at
                });
            }
            
            req.user = decoded;
            req.user.role = row.role;
            req.user.native_language = row.native_language;
            
            let rbacPolicies;
            try {
                rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
            } catch(e) {
                rbacPolicies = {};
            }
            
            const roles = (row.role || 'user').split(',').map(r => r.trim());
            const allowed_widgets_set = new Set();
            const allowed_actions_set = new Set();
            let hasWildcardModels = false;
            const allowed_models_set = new Set();

            roles.forEach(roleName => {
                const policy = rbacPolicies[roleName] || {};
                const widgets = policy.allowed_widgets || [];
                const actions = policy.allowed_actions || [];
                const models = policy.allowed_models || [];

                widgets.forEach(w => allowed_widgets_set.add(w));
                actions.forEach(a => allowed_actions_set.add(a));
                models.forEach(m => {
                    if (m === '*') hasWildcardModels = true;
                    else allowed_models_set.add(m);
                });
            });

            req.user.allowed_widgets = Array.from(allowed_widgets_set);
            req.user.allowed_actions = Array.from(allowed_actions_set);
            req.user.allowed_models = hasWildcardModels ? ['*'] : Array.from(allowed_models_set);

            return next();
        });
    });
}

// Middleware to check user auth (ZTA Real-time PDP Enforcement with Dynamic Context Check & Session Liveness)
function requireAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated', code: 'SESSION_EXPIRED' });
    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) {
            try {
                const expiredDecoded = jwt.decode(token);
                if (expiredDecoded && expiredDecoded.id) {
                    db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [expiredDecoded.id]);
                }
            } catch (_) {}
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Invalid or expired token', code: 'SESSION_EXPIRED' });
        }
        
        // ZTA動的コンテキスト検証 (セッションハイジャック防止)
        const hashes = getContextHashes(req);
        const isContextValid = !decoded.ip_hash || (decoded.ip_hash === hashes.ipHash && decoded.ua_hash === hashes.uaHash);
        if (!isContextValid) {
            if (decoded && decoded.id) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
            }
            auditDb.logEvent({
                userId: decoded.id,
                userEmail: decoded.email,
                eventType: 'session_hijacking_detected',
                action: `${req.method} ${req.originalUrl}`,
                status: 'blocked',
                req: req,
                details: { 
                    expectedIpHash: decoded.ip_hash, 
                    gotIpHash: hashes.ipHash, 
                    expectedUaHash: decoded.ua_hash, 
                    gotUaHash: hashes.uaHash,
                    clientIp: hashes.ip,
                    userAgent: hashes.ua
                }
            });
            clearSessionCookie(req, res);
            return res.status(401).json({ error: 'Session context mismatch. Security policy requires re-authentication.', code: 'SESSION_EXPIRED' });
        }

        // ZTA Real-time PDP check + Session Liveness enforcement
        db.get("SELECT role, native_language, email, status_text, last_active_at FROM users WHERE id = ?", [decoded.id], async (err, row) => {
            if (err || !row) {
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'User not found in database', code: 'SESSION_EXPIRED' });
            }

            if (!row.last_active_at) {
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Session terminated. Please sign in again.', code: 'SESSION_EXPIRED' });
            }

            const maxLockCount = await getSessionLockMaxCount();
            const hardLogoutTimeoutMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;
            const lastActiveMs = new Date(row.last_active_at).getTime();
            const idleMs = isNaN(lastActiveMs) ? Infinity : (Date.now() - lastActiveMs);

            if (idleMs >= hardLogoutTimeoutMs) {
                db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [decoded.id]);
                auditDb.logEvent({
                    userId: decoded.id,
                    userEmail: row.email || decoded.email,
                    eventType: 'session_timeout',
                    action: `ZTA Server-Side Forced Logout (${req.method} ${req.originalUrl})`,
                    status: 'blocked',
                    req: req,
                    details: {
                        reason: 'max_lock_cycles_exceeded',
                        lastActiveAt: row.last_active_at,
                        maxLockCount,
                        idleTimeoutMinutes: Math.round(hardLogoutTimeoutMs / 60000)
                    }
                });
                clearSessionCookie(req, res);
                return res.status(401).json({ error: 'Session idle timeout exceeded. Please sign in again.', code: 'SESSION_EXPIRED' });
            }

            const isSoftLocked = (row.status_text || '').toLowerCase() === 'offline' || (idleMs >= SESSION_IDLE_TIMEOUT_MS);
            if (isSoftLocked) {
                const lockCount = Math.max(1, Math.min(maxLockCount - 1, Math.floor(idleMs / SESSION_IDLE_TIMEOUT_MS) || 1));
                if ((row.status_text || '').toLowerCase() !== 'offline') {
                    db.run("UPDATE users SET status_text = 'Offline' WHERE id = ?", [decoded.id]);
                }
                return res.status(401).json({
                    error: 'Session is locked due to inactivity. Please re-authenticate to continue.',
                    code: 'SESSION_LOCKED',
                    lockCount,
                    maxLockCount,
                    lastActiveAt: row.last_active_at
                });
            }
            
            req.user = decoded;
            req.user.role = row.role;
            req.user.native_language = row.native_language;
            
            let rbacPolicies;
            try {
                rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
            } catch(e) {
                rbacPolicies = {};
            }
            
            const roles = (row.role || 'user').split(',').map(r => r.trim());
            const allowed_widgets_set = new Set();
            const allowed_actions_set = new Set();
            let hasWildcardModels = false;
            const allowed_models_set = new Set();
            
            roles.forEach(r => {
                const policy = rbacPolicies[r] || rbacPolicies['user'] || {};
                (policy.allowed_widgets || []).forEach(w => allowed_widgets_set.add(w));
                (policy.allowed_actions || []).forEach(a => allowed_actions_set.add(a));
                (policy.allowed_models || []).forEach(m => {
                    if (m === '*') hasWildcardModels = true;
                    allowed_models_set.add(m);
                });
            });
            
            // Universal default widgets (only settings is universally added; other widgets follow PDP RBAC_POLICIES)
            ['app:settings'].forEach(w => allowed_widgets_set.add(w));
            
            req.user.allowed_widgets = allowed_widgets_set.has('*') ? ['*'] : Array.from(allowed_widgets_set);
            req.user.allowed_actions = allowed_actions_set.has('*') ? ['*'] : Array.from(allowed_actions_set);
            req.user.allowed_models = hasWildcardModels ? ['*'] : Array.from(allowed_models_set);
            
            next();
        });
    });
}

// Helper to determine if a user is from an external domain (ZTA boundary constraint)
async function isExternalUser(user) {
    if (!user || !user.email || !user.email.includes('@')) return false;
    if (user.id === 0 || user.role === 'admin' || user.email === 'system@init') return false;
    
    // 1. Get host domain
    let hostDomain = await db.getSetting('HOST_DOMAIN') || process.env.HOST_DOMAIN;
    if (!hostDomain) {
        // Fallback: get the domain of the first admin in the database
        try {
            const firstAdmin = await new Promise((resolve, reject) => {
                db.get("SELECT email FROM users WHERE role LIKE '%admin%' ORDER BY id ASC LIMIT 1", [], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (firstAdmin && firstAdmin.email && firstAdmin.email.includes('@')) {
                hostDomain = firstAdmin.email.split('@')[1];
            }
        } catch (err) {
            console.error("Failed to find fallback host domain from admin email:", err);
        }
    }
    
    // If still no host domain resolved, default to "techiespod.jp" (default domain of current user) or first user's domain
    if (!hostDomain) {
        try {
            const firstUser = await new Promise((resolve, reject) => {
                db.get("SELECT email FROM users ORDER BY id ASC LIMIT 1", [], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (firstUser && firstUser.email && firstUser.email.includes('@')) {
                hostDomain = firstUser.email.split('@')[1];
            }
        } catch (e) {
            hostDomain = 'techiespod.jp';
        }
    }

    if (!hostDomain) hostDomain = 'techiespod.jp';
    
    hostDomain = hostDomain.toLowerCase().trim();
    const userDomain = user.email.split('@')[1] ? user.email.split('@')[1].toLowerCase().trim() : '';
    
    return hostDomain !== userDomain;
}

// Middleware for web pages (HTML) to gracefully redirect to login error
function requireAuthPage(req, res, next) {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).send(`
            <html>
            <head><style>body { font-family: sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 2rem; } a { color: #58a6ff; }</style></head>
            <body>
            <h1>401 Unauthorized</h1>
            <p>ご指定のレポートを閲覧する権限がありません。<br>Employee-Agentシステムにログインしてください。</p>
            <p><a href="/">ログイン画面に戻る</a></p>
            </body>
            </html>
        `);
    }
    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) {
            return res.status(403).send(`
                <html>
                <head><style>body { font-family: sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 2rem; } a { color: #58a6ff; }</style></head>
                <body>
                <h1>403 Forbidden</h1>
                <p>セッションの有効期限が切れているか、レポートを閲覧する権限がありません。</p>
                <p><a href="/">ログイン画面に戻る</a></p>
                </body>
                </html>
            `);
        }
        req.user = decoded;
        next();
    });
}

// Middleware to check admin role
// Middleware to check action permission (PEP)
// Middleware to check action permission (PEP)
function requirePermission(action) {
    return (req, res, next) => {
        const evaluateActionPermission = () => {
            const allowedActions = req.user.allowed_actions || [];
            const hasPermission = allowedActions.includes('*') || allowedActions.includes(action);
            
            if (!hasPermission) {
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'permission_denied',
                    action: `${req.method} ${req.originalUrl}`,
                    status: 'blocked',
                    req: req,
                    details: { requiredAction: action }
                });
                return res.status(403).json({ error: `Permission denied. Requires action: ${action}` });
            }
            return next();
        };

        if (req.user) {
            return evaluateActionPermission();
        }

        // ZTA: Always delegate to requireAuth so real-time DB & PDP check is enforced
        return requireAuth(req, res, evaluateActionPermission);
    };
}

// Middleware to check widget access (PEP) + Universal Grant operation_level check
function requireWidgetAccess(widgetId) {
    return (req, res, next) => {
        const evaluateWidgetPermission = async () => {
            const allowedWidgets = req.user.allowed_widgets || [];
            const hasAccess = allowedWidgets.includes('*') || allowedWidgets.includes(widgetId);
            
            if (!hasAccess) {
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'permission_denied',
                    action: `${req.method} ${req.originalUrl}`,
                    status: 'blocked',
                    req: req,
                    details: { requiredWidget: widgetId }
                });
                return res.status(403).json({ error: `Access denied. Requires widget access: ${widgetId}` });
            }

            // Enforce read_only vs execute/read_write on DeepResearch & Knowledge Base mutation endpoints
            const cleanWidgetId = String(widgetId).replace(/^app:/, '');
            if (req.method === 'POST' && (cleanWidgetId === 'deep-research' || cleanWidgetId === 'knowledge-base')) {
                const isKnowledgeCreation = cleanWidgetId === 'knowledge-base' && (req.path === '/' || req.path === '');
                const isDeepResearchStart = cleanWidgetId === 'deep-research' && (req.path === '/' || req.path === '' || req.path.includes('/start'));
                if (isKnowledgeCreation || isDeepResearchStart) {
                    const effLevel = await ztaPdpService.evaluateUserWidgetLevel(req.user, cleanWidgetId);
                    if (effLevel === 'read') {
                        auditDb.logEvent({
                            userId: req.user.id,
                            userEmail: req.user.email,
                            eventType: 'permission_denied',
                            action: `${req.method} ${req.originalUrl}`,
                            status: 'blocked',
                            req: req,
                            details: { requiredWidget: widgetId, effectiveLevel: effLevel, reason: 'Blocked by read_only widget grant' }
                        });
                        return res.status(403).json({
                            error: `Access denied (ZTA PEP): このロールは「参照のみ (read_only)」権限のため、${cleanWidgetId === 'deep-research' ? '新規 DeepResearch 調査の実行' : 'ナレッジベースへの新規記事登録'}はブロックされました。`
                        });
                    }
                }
            }

            return next();
        };

        if (req.user) {
            return evaluateWidgetPermission();
        }

        // ZTA: Always delegate to requireAuth so real-time DB & PDP check is enforced
        return requireAuth(req, res, evaluateWidgetPermission);
    };
}

// --- Users & Invitations API ---
app.get('/api/users', requireAuth, (req, res) => {
    const allowed = req.user.allowed_actions || [];
    if (!allowed.includes('*') && !allowed.includes('action:manage_users') && !allowed.includes('action:invite_users')) {
        return res.status(403).json({ error: 'Permission denied' });
    }
    db.all("SELECT id, email, name, avatar_url, role, native_language, deep_research_enabled, created_at FROM users", (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.get('/api/users/:id/permissions', requireAuth, (req, res) => {
    const { id } = req.params;
    
    // Admins and the user themselves can view their permissions
    const isSelf = parseInt(id) === req.user.id;
    const allowed = req.user.allowed_actions || [];
    const canManageRoles = allowed.includes('*') || allowed.includes('action:manage_roles');
    
    if (!isSelf && !canManageRoles) {
        return res.status(403).json({ error: 'Permission denied' });
    }

    db.get("SELECT id, role FROM users WHERE id = ?", [id], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'User not found' });

        let rbacPolicies = {};
        try {
            const rbacJson = await db.getSetting('RBAC_POLICIES');
            if (rbacJson) rbacPolicies = JSON.parse(rbacJson);
        } catch (e) {
            console.error("Failed to fetch RBAC_POLICIES for permissions API", e);
        }

        const roles = (user.role || 'user').split(',').map(r => r.trim());
        let allowed_widgets_set = new Set();
        let allowed_actions_set = new Set();
        let allowed_models_set = new Set();

        roles.forEach(r => {
            const policy = rbacPolicies[r] || rbacPolicies['user'] || {};
            (policy.allowed_widgets || []).forEach(w => allowed_widgets_set.add(w));
            (policy.allowed_actions || []).forEach(a => allowed_actions_set.add(a));
            (policy.allowed_models || []).forEach(m => allowed_models_set.add(m));
        });

        // Implicit built-in apps
        ['app:settings'].forEach(w => allowed_widgets_set.add(w));

        res.json({
            user_id: user.id,
            roles: roles,
            allowed_widgets: allowed_widgets_set.has('*') ? ['*'] : Array.from(allowed_widgets_set),
            allowed_actions: allowed_actions_set.has('*') ? ['*'] : Array.from(allowed_actions_set),
            allowed_models: allowed_models_set.has('*') ? ['*'] : Array.from(allowed_models_set)
        });
    });
});

app.put('/api/users/:id/role', requirePermission('action:manage_roles'), (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    
    // First fetch the target user to see if they currently have the admin role
    db.get("SELECT role FROM users WHERE id = ?", [id], (err, targetUser) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        
        const currentRoles = (targetUser.role || '').split(',').map(r => r.trim());
        const isCurrentlyAdmin = currentRoles.includes('admin');
        
        const newRoles = (role || '').split(',').map(r => r.trim());
        const isNewAdmin = newRoles.includes('admin');
        
        const proceedWithUpdate = () => {
            db.run("UPDATE users SET role = ? WHERE id = ?", [role, id], function(err) {
                if (err) {
                    auditDb.logEvent({
                        userId: req.user.id,
                        userEmail: req.user.email,
                        eventType: 'role_changed',
                        action: `PUT /api/users/${id}/role`,
                        status: 'failure',
                        req: req,
                        details: { error: 'Database error', targetUserId: id }
                    });
                    return res.status(500).json({ error: 'Database error' });
                }
                if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
                
                // 成功を監査ログに記録
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'role_changed',
                    action: `PUT /api/users/${id}/role`,
                    status: 'success',
                    req: req,
                    details: { targetUserId: id, newRole: role }
                });
                
                res.json({ success: true, role });
            });
        };

        if (isCurrentlyAdmin && !isNewAdmin) {
            // Safety Validation: Safeguard 2 - Admin demotion check
            db.all("SELECT id, role FROM users", [], (err, allUsers) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                
                // Count how many users currently have the admin role
                const adminCount = allUsers.filter(u => {
                    const uRoles = (u.role || '').split(',').map(r => r.trim());
                    return uRoles.includes('admin');
                }).length;
                
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot demote the only administrator in the system.' });
                }
                
                proceedWithUpdate();
            });
        } else {
            proceedWithUpdate();
        }
    });
});

app.put('/api/users/me/avatar', requireAuth, (req, res) => {
    const { avatar_url } = req.body;
    if (!avatar_url) return res.status(400).json({ error: 'Avatar URL is required' });
    
    db.run("UPDATE users SET avatar_url = ? WHERE id = ?", [avatar_url, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, avatar_url });
    });
});

app.put('/api/users/me/language', requireAuth, (req, res) => {
    const { native_language } = req.body;
    if (!native_language) return res.status(400).json({ error: 'Language is required' });
    const lang = ['ja', 'en', 'es'].includes(native_language) ? native_language : 'ja';
    
    db.run("UPDATE users SET native_language = ? WHERE id = ?", [lang, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        req.user.native_language = lang;
        res.json({ success: true, native_language: lang });
    });
});

app.put('/api/users/:id/language', requireAuth, (req, res) => {
    const allowed = req.user.allowed_actions || [];
    if (!allowed.includes('*') && !allowed.includes('action:manage_users')) {
        return res.status(403).json({ error: 'Permission denied' });
    }
    const { id } = req.params;
    const { native_language } = req.body;
    const lang = ['ja', 'en', 'es'].includes(native_language) ? native_language : 'ja';
    
    db.run("UPDATE users SET native_language = ? WHERE id = ?", [lang, id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, id, native_language: lang });
    });
});

app.get('/api/virtual-office/users', requireAuth, (req, res) => {
    const loginUserId = req.user.id;

    // NOTE: 3秒ごとのバックグラウンドポーリングで last_active_at を無条件更新すると、
    // 無操作放置中でも永続的に Online が維持されてしまうため、ここでは更新しない。
    // last_active_at は実操作ハートビート (/api/auth/me?active=1) および明示的なステータス更新時のみ更新する。

    const sql = `
        SELECT u.id, u.email, u.name, u.avatar_url, u.role, u.current_room, u.status_text, u.is_remote, u.last_active_at,
               u.assistant_work_start, u.assistant_work_end, u.assistant_break_start, u.assistant_break_end, u.assistant_meeting_buffer, u.assistant_prompt, u.native_language,
               (SELECT COUNT(*) FROM dm_messages m WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0) as unread_count
        FROM users u
    `;
    db.all(sql, [loginUserId], async (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        const maxLockCount = await getSessionLockMaxCount();
        const hardLogoutThresholdMs = maxLockCount * SESSION_IDLE_TIMEOUT_MS;
        
        const enriched = rows.map(user => {
            const isOffline = isUserOffline(user, null);
            if (isOffline && (user.status_text || '').toLowerCase() !== 'offline') {
                const hadLastActive = !!user.last_active_at;
                const prevLastActive = user.last_active_at;
                const lastActiveMs = user.last_active_at ? new Date(user.last_active_at).getTime() : NaN;
                const idleMs = Number.isNaN(lastActiveMs) ? Infinity : (Date.now() - lastActiveMs);
                if (idleMs >= hardLogoutThresholdMs) {
                    db.run("UPDATE users SET status_text = 'Offline', last_active_at = NULL WHERE id = ?", [user.id], () => {});
                } else {
                    // ソフトロック期間中は status_text のみ Offline に更新し、last_active_at はサイクル計測のため保持する
                    db.run("UPDATE users SET status_text = 'Offline' WHERE id = ?", [user.id], () => {});
                }
                if (hadLastActive) {
                    auditDb.logEvent({
                        userId: user.id,
                        userEmail: user.email,
                        eventType: 'session_timeout',
                        action: 'ZTA Virtual Office Presence Idle Timeout',
                        status: 'success',
                        req: req,
                        details: {
                            reason: 'virtual_office_idle_timeout_detected',
                            lastActiveAt: prevLastActive,
                            idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MS / 60000
                        }
                    });
                }
            }

            return {
                ...user,
                is_offline: isOffline,
                is_remote: user.is_remote ?? 0,
                current_room: user.current_room || 'open-space',
                status_text: isOffline ? 'Offline' : (user.status_text || 'Active'),
                unread_count: user.unread_count || 0,
                native_language: user.native_language || 'ja',
                assistant_work_start: user.assistant_work_start || '09:00',
                assistant_work_end: user.assistant_work_end || '17:30',
                assistant_break_start: user.assistant_break_start || '12:00',
                assistant_break_end: user.assistant_break_end || '13:00',
                assistant_meeting_buffer: user.assistant_meeting_buffer !== undefined ? user.assistant_meeting_buffer : 30,
                assistant_prompt: user.assistant_prompt || ''
            };
        });
        res.json(enriched);
    });
});

app.post('/api/virtual-office/settings', requireAuth, async (req, res) => {
    const { assistant_work_start, assistant_work_end, assistant_break_start, assistant_break_end, assistant_meeting_buffer, assistant_prompt, override } = req.body;
    const userId = req.user.id;

    // ZTA Security Boundary Check: Block external domain users
    if (await isExternalUser(req.user)) {
        return res.status(403).json({ error: 'Permission denied. External domain users cannot change AI assistant settings.' });
    }

    // 1. ロール・アクション権限のチェック
    const allowedActions = req.user.allowed_actions || [];
    const hasPermission = allowedActions.includes('*') || allowedActions.includes('action:manage_assistant_rules');
    if (!hasPermission) {
        return res.status(403).json({ error: 'Permission denied. Requires action:manage_assistant_rules' });
    }

    // 2. 変更前プロンプトの取得
    db.get("SELECT assistant_prompt FROM users WHERE id = ?", [userId], async (err, row) => {
        if (err) {
            console.error("Failed to fetch previous assistant settings:", err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const previousPrompt = row ? row.assistant_prompt : '';
        const newPrompt = assistant_prompt !== undefined ? assistant_prompt : previousPrompt;

        let isCompliant = true;
        let warningReason = '';

        // 3. プロンプト変更時のみ就業規則審査（変更がない場合はスキップして誤検知を防ぐ）
        const isPromptChanged = assistant_prompt !== undefined && assistant_prompt !== previousPrompt;
        if (isPromptChanged) {
            const companyWorkPolicy = await db.getSetting('COMPANY_WORK_POLICY') || '';
            const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
            const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
            const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

            if ((apiKey || claudeApiKey) && companyWorkPolicy) {
                try {
                    const systemInstruction = `あなたは会社のコンプライアンスおよび労働管理（36協定）の監査用AIです。
提供された「就業規則」と、ユーザーが設定しようとしている「AIアシスタント用プロンプト」を比較し、AIアシスタントの指示が就業規則に違反している（または違反を助長している）疑いがないかを判定してください。

特に以下の点に注意してください。
1. 午後22:00から翌午前05:00までの深夜時間帯でのアポイントを自動調整・受託するような記述、または深夜労働を推奨・助長する記述。
2. 就業時間外（例: 17:30以降など）の打ち合わせを、ユーザーの確認や承認なしに【自動で仮登録】するプロンプト指示、または「いかなる時間でも無制限にアポを入れて構わない」といった過重労働を容認する指示。
   ※ただし、時間外アポイントに対して自動調整せず、「BOSSに確認する」ボタンを表示してユーザーに確認を求めるプロセスや、時間外アポをBOSS自身が手動承認するプロセスについての指示は、過重労働の容認とはみなさず、許容（COMPLIANT）してください。
3. 休憩時間（例: 12:00-13:00）におけるアポイントを自動調整・受託するような記述。休憩時間は労働者の健康管理のために必須であり、この時間帯の自動調整は原則禁止（NON-COMPLIANT）と判定してください。
4. ハラスメントや情報の漏洩など、その他就業規則に反する指示。

出力は、以下のJSON形式で返答してください。JSON以外の余計な記述やマークダウンタグ（\`\`\`json等）を含めないでください。
{
  "compliant": trueまたはfalse（違反の疑いがない場合はtrue、違反またはその疑いがある場合はfalse）,
  "reason": "違反の疑いがある場合の具体的な懸念・違反箇所についての理由説明（日本語）"
}`;

                    const userContent = `【就業規則】
${companyWorkPolicy}

【AIアシスタント用プロンプト】
${newPrompt}`;

                    let rawJsonText = '';
                    if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
                        const claudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
                        rawJsonText = await llmAdapter.generateTextWithClaude({
                            apiKey: claudeApiKey,
                            model: claudeModel,
                            prompt: userContent,
                            systemInstruction,
                            temperature: 0.2,
                            jsonMode: true
                        });
                    } else if (apiKey) {
                        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
                        const model = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
                        const response = await client.models.generateContent({
                            model: model,
                            contents: userContent,
                            config: {
                                systemInstruction: systemInstruction,
                                responseMimeType: "application/json",
                                responseSchema: {
                                    type: "OBJECT",
                                    properties: {
                                        compliant: { type: "BOOLEAN", description: "Whether the prompt is compliant with the work policy" },
                                        reason: { type: "STRING", description: "The detailed reason if there is a suspected violation" }
                                    },
                                    required: ["compliant", "reason"]
                                }
                            }
                        });
                        rawJsonText = response.text || '';
                    }

                    if (rawJsonText) {
                        try {
                            const cleanJson = rawJsonText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                            const evaluation = JSON.parse(cleanJson);
                            isCompliant = evaluation.compliant !== false;
                            warningReason = evaluation.reason || '';
                        } catch (parseErr) {
                            console.error("Failed to parse compliance response JSON:", parseErr, rawJsonText);
                        }
                    }
                } catch (geminiErr) {
                    console.error("Failed to evaluate prompt compliance via AI:", geminiErr);
                    // AI APIで何らかのエラーが起きた場合は、システム全体がブロックされないように適合扱いとする
                }
            }
        }

        // 4. 違反が疑われ、かつ強制保存フラグがない場合は一時ブロックして警告を返す
        if (!isCompliant && override !== true) {
            // 監査ログにブロック（blocked）として記録
            await auditDb.logEvent({
                userId: req.user.id,
                userEmail: req.user.email,
                eventType: 'policy_compliance',
                action: 'update_assistant_settings',
                status: 'blocked',
                req: req,
                details: {
                    policy_compliance: 'SUSPECTED_VIOLATION',
                    warning_reason: warningReason,
                    previous_prompt: previousPrompt,
                    new_prompt: newPrompt,
                    override: false
                }
            });

            return res.json({ status: 'warning', reason: warningReason });
        }

        // 5. 保存実行
        db.run(
            `UPDATE users SET 
                assistant_work_start = COALESCE(?, assistant_work_start), 
                assistant_work_end = COALESCE(?, assistant_work_end), 
                assistant_break_start = COALESCE(?, assistant_break_start),
                assistant_break_end = COALESCE(?, assistant_break_end),
                assistant_meeting_buffer = COALESCE(?, assistant_meeting_buffer),
                assistant_prompt = COALESCE(?, assistant_prompt)
             WHERE id = ?`,
            [assistant_work_start, assistant_work_end, assistant_break_start, assistant_break_end, assistant_meeting_buffer, assistant_prompt, userId],
            async (updateErr) => {
                if (updateErr) {
                    console.error("Failed to update assistant settings:", updateErr);
                    return res.status(500).json({ error: 'Failed to update assistant settings' });
                }

                // 6. 成功（または強制保存）を監査ログに記録
                const complianceStatus = warningReason ? 'SUSPECTED_VIOLATION' : 'COMPLIANT';
                await auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'policy_compliance',
                    action: 'update_assistant_settings',
                    status: override ? 'override' : 'success',
                    req: req,
                    details: {
                        policy_compliance: complianceStatus,
                        warning_reason: warningReason || null,
                        previous_prompt: previousPrompt,
                        new_prompt: newPrompt,
                        override: !!override
                    }
                });

                res.json({ status: 'ok' });
            }
        );
    });
});

app.post('/api/virtual-office/status', requireAuth, (req, res) => {
    const { current_room, status_text, is_remote, native_language, targetUserId } = req.body;
    const userId = targetUserId || req.user.id;
    const isSelfAction = Number(userId) === Number(req.user.id);
    
    db.get("SELECT current_room, status_text, is_remote, native_language, last_active_at FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            console.error('Error fetching user status:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const nextRoom = current_room !== undefined ? current_room : (user.current_room || 'open-space');
        const nextStatus = status_text !== undefined ? status_text : (user.status_text || 'Active');
        const nextRemote = is_remote !== undefined ? is_remote : (user.is_remote ?? 0);
        const nextLang = native_language !== undefined ? native_language : (user.native_language || 'ja');
        const nextLastActive = nextStatus.toLowerCase() === 'offline'
            ? null
            : (isSelfAction ? new Date().toISOString() : user.last_active_at);
        
        db.run(
            "UPDATE users SET current_room = ?, status_text = ?, is_remote = ?, native_language = ?, last_active_at = ? WHERE id = ?",
            [nextRoom, nextStatus, nextRemote, nextLang, nextLastActive, userId],
            function(updateErr) {
                if (updateErr) {
                    console.error('Error updating user status:', updateErr);
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({
                    success: true,
                    status: {
                        current_room: nextRoom,
                        status_text: nextStatus,
                        is_remote: nextRemote,
                        native_language: nextLang,
                        is_offline: nextStatus.toLowerCase() === 'offline' || !nextLastActive
                    }
                });
            }
        );
    });
});

app.post('/api/virtual-office/generate-avatar', requireAuth, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    
    const avatarSeeds = [
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=John',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Jane',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Minoru',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Inui',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=AI',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Nico',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Leo',
        'https://api.dicebear.com/7.x/pixel-art/svg?seed=Mimi'
    ];
    
    const randomAvatar = avatarSeeds[Math.floor(Math.random() * avatarSeeds.length)];
    
    db.run("UPDATE users SET avatar_url = ? WHERE id = ?", [randomAvatar, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, avatar_url: randomAvatar });
    });
});

app.get('/api/invitations', requireAuth, (req, res) => {
    const allowed = req.user.allowed_actions || [];
    if (!allowed.includes('*') && !allowed.includes('action:manage_users') && !allowed.includes('action:invite_users')) {
        return res.status(403).json({ error: 'Permission denied' });
    }
    db.all("SELECT email, invited_by, created_at FROM invitations", (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        const now = new Date();
        const enrichedRows = rows.map(row => {
            const inviteDate = new Date(row.created_at + 'Z');
            const diffDays = (now - inviteDate) / (1000 * 60 * 60 * 24);
            const status = diffDays > 3 ? 'Expired' : 'Pending';
            return { ...row, status };
        });
        
        res.json(enrichedRows);
    });
});

app.post('/api/invitations', requireAuth, (req, res) => {
    const allowed = req.user.allowed_actions || [];
    const isAuthorized = allowed.includes('*') || allowed.includes('action:manage_users') || allowed.includes('action:invite_users');
    if (!isAuthorized) {
        auditDb.logEvent({
            userId: req.user.id,
            userEmail: req.user.email,
            eventType: 'permission_denied',
            action: 'POST /api/invitations',
            status: 'blocked',
            req: req,
            details: { error: 'User not authorized to invite others' }
        });
        return res.status(403).json({ error: 'Permission denied' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    
    // Check if already user or invited
    db.get("SELECT email FROM users WHERE email = ?", [email], (err, user) => {
        if (user) return res.status(400).json({ error: 'User already exists' });
        
        db.run("INSERT INTO invitations (email, invited_by) VALUES (?, ?)", [email, req.user.id], function(err) {
            if (err) {
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'user_invited',
                    action: 'POST /api/invitations',
                    status: 'failure',
                    req: req,
                    details: { error: 'Email already invited or DB error', inviteeEmail: email }
                });
                return res.status(500).json({ error: 'Email already invited or DB error' });
            }
            
            // 成功を監査ログに記録
            auditDb.logEvent({
                userId: req.user.id,
                userEmail: req.user.email,
                eventType: 'user_invited',
                action: 'POST /api/invitations',
                status: 'success',
                req: req,
                details: { inviteeEmail: email }
            });
            
            res.json({ success: true, email });
        });
    });
});

app.delete('/api/invitations/:email', requirePermission('action:manage_users'), (req, res) => {
    const { email } = req.params;
    db.run("DELETE FROM invitations WHERE email = ?", [email], function(err) {
        if (err) {
            auditDb.logEvent({
                userId: req.user.id,
                userEmail: req.user.email,
                eventType: 'invitation_deleted',
                action: `DELETE /api/invitations/${email}`,
                status: 'failure',
                req: req,
                details: { error: 'Database error', targetEmail: email }
            });
            return res.status(500).json({ error: 'Database error' });
        }
        
        // 成功を監査ログに記録
        auditDb.logEvent({
            userId: req.user.id,
            userEmail: req.user.email,
            eventType: 'invitation_deleted',
            action: `DELETE /api/invitations/${email}`,
            status: 'success',
            req: req,
            details: { targetEmail: email }
        });
        
        res.json({ success: true });
    });
});

app.delete('/api/users/:id', requirePermission('action:manage_users'), (req, res) => {
    const targetId = req.params.id;
    if (parseInt(targetId) === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    
    db.get("SELECT email, role FROM users WHERE id = ?", [targetId], (err, targetUser) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        
        const targetEmail = targetUser.email || 'unknown';
        const targetRoles = (targetUser.role || '').split(',').map(r => r.trim());
        const isTargetAdmin = targetRoles.includes('admin');
        
        const proceedToDelete = () => {
            db.run("DELETE FROM users WHERE id = ?", [targetId], function(err) {
                if (err) {
                    auditDb.logEvent({
                        userId: req.user.id,
                        userEmail: req.user.email,
                        eventType: 'user_deleted',
                        action: `DELETE /api/users/${targetId}`,
                        status: 'failure',
                        req: req,
                        details: { error: 'Database error', targetUserId: targetId, targetUserEmail: targetEmail }
                    });
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // 成功を監査ログに記録
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'user_deleted',
                    action: `DELETE /api/users/${targetId}`,
                    status: 'success',
                    req: req,
                    details: { targetUserId: targetId, targetUserEmail: targetEmail }
                });
                
                res.json({ success: true });
            });
        };

        if (isTargetAdmin) {
            // Safety Validation: Safeguard 2 - Admin deletion check
            db.all("SELECT id, role FROM users", [], (err, allUsers) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                
                const adminCount = allUsers.filter(u => {
                    const uRoles = (u.role || '').split(',').map(r => r.trim());
                    return uRoles.includes('admin');
                }).length;
                
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot delete the only administrator in the system.' });
                }
                
                proceedToDelete();
            });
        } else {
            proceedToDelete();
        }
    });
});

// Security Audit Logs: Fetch logs (Admin only)
app.get('/api/security-logs', requireAuth, requirePermission('action:manage_system_settings'), async (req, res) => {
    try {
        const logs = await auditDb.getLogs(500);
        res.json(logs);
    } catch (error) {
        console.error("Failed to fetch security logs:", error);
        res.status(500).json({ error: 'Failed to fetch security logs' });
    }
});


// Default standard Gemini models fallback
const DEFAULT_GEMINI_MODELS = [
    {
        name: 'models/gemini-3.1-flash-lite-preview',
        displayName: 'Gemini 3.1 Flash Lite Preview',
        description: 'High-speed, cost-efficient model for lightweight reasoning and high-throughput tasks.',
        inputTokenLimit: 1048576,
        outputTokenLimit: 8192
    },
    {
        name: 'models/gemini-3.1-pro-preview',
        displayName: 'Gemini 3.1 Pro Preview',
        description: 'Advanced intelligence for complex reasoning, analysis, and multimodal problem solving.',
        inputTokenLimit: 2097152,
        outputTokenLimit: 8192
    },
    {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        description: 'Next-generation multimodal model optimized for speed and high volume.',
        inputTokenLimit: 1048576,
        outputTokenLimit: 8192
    },
    {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        description: 'Capable model for complex reasoning tasks.',
        inputTokenLimit: 2097152,
        outputTokenLimit: 8192
    },
    {
        name: 'models/gemini-3.1-flash-image',
        displayName: 'Gemini 3.1 Flash Image',
        description: 'Dedicated multimodal model for image and avatar generation.',
        inputTokenLimit: 32768,
        outputTokenLimit: 8192
    }
];

app.get('/api/gemini/models', requireAuth, requireWidgetAccess('app:gemini'), async (req, res) => {
    try {
        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

        let claudeModelsList = llmAdapter.INITIAL_CLAUDE_MODELS;
        try {
            const rawClaude = await llmAdapter.listClaudeModels(claudeApiKey, db);
            if (Array.isArray(rawClaude) && rawClaude.length > 0) {
                claudeModelsList = rawClaude;
            } else if (rawClaude && Array.isArray(rawClaude.models)) {
                claudeModelsList = rawClaude.models;
            }
        } catch (cErr) {
            console.warn("Could not list Claude models in /api/gemini/models:", cErr.message);
        }

        if (!apiKey) {
            return res.json({
                models: DEFAULT_GEMINI_MODELS,
                claudeModels: claudeModelsList,
                isConfigured: false,
                isClaudeConfigured: !!claudeApiKey,
                aiProvider
            });
        }

        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60000 } });
        const response = await client.models.list();

        let modelsList = [];
        try {
            if (response && response.page && Array.isArray(response.page)) {
                modelsList = response.page;
            } else if (response && typeof response[Symbol.asyncIterator] === 'function') {
                for await (const m of response) {
                    modelsList.push(m);
                }
            } else {
                const jsonResponse = JSON.parse(JSON.stringify(response));
                modelsList = jsonResponse.models || jsonResponse.pageInternal || [];
            }
        } catch (iterErr) {
            console.warn("Could not iterate model pager, using fallback list:", iterErr.message);
        }

        // Filter and format models
        let models = modelsList.filter(m =>
            !m.supportedActions || m.supportedActions.includes('generateContent')
        ).map(m => ({
            name: m.name,
            displayName: m.displayName || m.name,
            description: m.description || '',
            inputTokenLimit: m.inputTokenLimit || 1048576,
            outputTokenLimit: m.outputTokenLimit || 8192,
            provider: 'gemini'
        }));

        if (models.length === 0) {
            models = DEFAULT_GEMINI_MODELS.map(m => ({ ...m, provider: 'gemini' }));
        }

        res.json({
            models,
            claudeModels: claudeModelsList,
            isConfigured: true,
            isClaudeConfigured: !!claudeApiKey,
            aiProvider
        });
    } catch (error) {
        console.error("Error listing models, returning default models:", error);
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        let claudeModelsList = llmAdapter.INITIAL_CLAUDE_MODELS;
        try {
            const rawClaude = await llmAdapter.listClaudeModels(claudeApiKey, db);
            if (Array.isArray(rawClaude) && rawClaude.length > 0) {
                claudeModelsList = rawClaude;
            }
        } catch (_) {}
        res.json({
            models: DEFAULT_GEMINI_MODELS,
            claudeModels: claudeModelsList,
            isConfigured: false,
            isClaudeConfigured: !!claudeApiKey,
            warning: "Using fallback model list"
        });
    }
});

// Anthropic Claude Models API (Dynamic Model List via API Key)
app.get('/api/claude/models', requireAuth, async (req, res) => {
    try {
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const result = await llmAdapter.listClaudeModels(claudeApiKey, db);
        const modelsList = Array.isArray(result) ? result : (result?.models || llmAdapter.INITIAL_CLAUDE_MODELS);
        res.json({
            models: modelsList,
            claudeModels: modelsList,
            isConfigured: !!claudeApiKey,
            isClaudeConfigured: !!claudeApiKey
        });
    } catch (error) {
        console.error("Error listing Claude models:", error);
        res.json({
            models: llmAdapter.INITIAL_CLAUDE_MODELS,
            claudeModels: llmAdapter.INITIAL_CLAUDE_MODELS,
            isConfigured: false,
            isClaudeConfigured: false,
            warning: error.message
        });
    }
});

// Gemini Job Store (In-memory)
const geminiJobs = {};

// Background Gemini Job Processor

app.get('/api/gemini/job/:jobId', requireAuth, (req, res) => {
    const { jobId } = req.params;
    const job = geminiJobs[jobId];
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    // Avatar creation jobs or users with app:gemini access can check their own jobs
    const isAvatarJob = job.isAvatarGeneration || job.mode === 'nanobanana' || (job.googleId && job.googleId === req.user.googleId);
    const allowedWidgets = req.user.allowed_widgets || [];
    const hasWidgetAccess = allowedWidgets.includes('*') || allowedWidgets.includes('app:gemini');

    if (!isAvatarJob && !hasWidgetAccess) {
        return res.status(403).json({ error: 'Access denied. Requires widget access: app:gemini' });
    }
    // ZTAジョブ盗み見防止: ジョブの所有者であることを検証
    if (job.googleId && job.googleId !== req.user.googleId) {
        auditDb.logEvent({
            userId: req.user.id,
            userEmail: req.user.email,
            eventType: 'permission_denied',
            action: `GET /api/gemini/job/${jobId}`,
            status: 'blocked',
            req: req,
            details: { error: 'Job hijacking attempt', details: 'Attempted to view a background job belonging to another user' }
        });
        return res.status(403).json({ error: 'Access denied. You do not own this job.' });
    }
    res.json(job);
});



app.post('/api/gemini/tts', requireWidgetAccess('app:gemini'), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        if (!apiKey) return res.status(400).json({ error: '⚠️ 音声読み上げ（TTS）は Google Gemini 専用機能です。利用するには System Settings で Gemini API Key を設定してください。', geminiOnly: true });

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: text }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: "Kore" }
                        }
                    }
                }
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`TTS API Error: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        res.json(result);

    } catch (error) {
        console.error("TTS Endpoint Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/gemini/proxy', requireWidgetAccess('app:gemini'), async (req, res) => {
    try {
        const targetUrl = req.query.target;
        if (!targetUrl) return res.status(400).json({ error: 'Target URL is required' });

        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        if (!apiKey) return res.status(400).json({ error: '⚠️ 音声読み上げ（TTS）は Google Gemini 専用機能です。利用するには System Settings で Gemini API Key を設定してください。', geminiOnly: true });

        // Construct the new URL with the server-side API key
        const urlObj = new URL(targetUrl);
        urlObj.searchParams.set('key', apiKey);

        // Forward the request
        const response = await fetch(urlObj.toString(), {
            method: req.method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Proxy Upstream Error:", response.status, errorText);
            return res.status(response.status).send(errorText);
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Gemini Proxy Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Dedicated AI Avatar Generation Endpoint with ZTA Security Audit Logging
app.post('/api/avatar/generate', requireAuth, async (req, res) => {
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    const googleId = req.user?.googleId;
    const { imageBase64 } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ error: 'imageBase64 is required' });
    }

    try {
        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(400).json({ error: '⚠️ AIアバター画像生成は Google Gemini 専用機能です。利用するには System Settings で Gemini API Key を設定してください。', geminiOnly: true });
        }

        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
        const globalModel = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
        const rawAvatarModel = await db.getSetting('GEMINI_NANO_BANANA_MODEL') || 'imagen-3.0-generate-002';
        const cleanGlobalModel = globalModel.replace(/^models\//, '');
        const cleanAvatarModel = rawAvatarModel.replace(/^models\//, '');

        console.log(`[AvatarGenerator] Processing avatar for user ${userEmail} using textModel=${cleanGlobalModel}, imageModel=${cleanAvatarModel}`);

        // Step 1: Extract facial features using Stateless generateContent
        const analysisPrompt = "この人物の特徴（髪型、髪の色、目の特徴、表情、服装、アクセサリーなど）を詳細に描写してください。性別や年齢の推定も含めてください。アバター生成のプロンプトとして利用します。";
        const analysisRes = await client.models.generateContent({
            model: cleanGlobalModel,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { data: imageBase64, mimeType: 'image/png' } },
                        { text: analysisPrompt }
                    ]
                }
            ]
        });

        const description = analysisRes.candidates?.[0]?.content?.parts?.[0]?.text || "Friendly anime character";
        console.log(`[AvatarGenerator] Facial description generated: ${description.substring(0, 80)}...`);

        // Step 2: Generate anime avatar image
        const imagePrompt = `以下の人物の特徴を元に、高品質で魅力的なアニメ調（Anime style）のアバター画像を1枚生成してください。背景はシンプルにしてください。\n\n【人物の特徴】\n${description}`;
        let generatedBase64 = null;

        // Try Strategy A: generateImages if model is imagen
        if (cleanAvatarModel.includes('imagen')) {
            try {
                const imgRes = await client.models.generateImages({
                    model: cleanAvatarModel,
                    prompt: imagePrompt,
                    config: {
                        numberOfImages: 1,
                        outputMimeType: "image/png",
                        aspectRatio: "1:1"
                    }
                });
                const imgBytes = imgRes.generatedImages?.[0]?.image?.imageBytes;
                if (imgBytes) generatedBase64 = imgBytes;
            } catch (err) {
                console.warn(`[AvatarGenerator] generateImages failed for ${cleanAvatarModel}: ${err.message}. Falling back to generateContent...`);
            }
        }

        // Try Strategy B: multimodal generateContent with responseModalities
        if (!generatedBase64) {
            const targetModel = cleanAvatarModel.includes('imagen') ? cleanGlobalModel : cleanAvatarModel;
            const imgRes = await client.models.generateContent({
                model: targetModel,
                contents: imagePrompt,
                config: {
                    responseModalities: ['IMAGE']
                }
            });
            const parts = imgRes.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
            if (imagePart) {
                generatedBase64 = imagePart.inlineData.data;
            }
        }

        if (!generatedBase64) {
            throw new Error("No image data returned from image generation model.");
        }

        const avatarUrl = `data:image/png;base64,${generatedBase64}`;

        // Step 3: Save to user profile in DB
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET avatar_url = ? WHERE google_id = ?", [avatarUrl, googleId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Step 4: Record Security Audit Log
        auditDb.logEvent({
            userId: userId,
            userEmail: userEmail,
            eventType: 'avatar_generation',
            action: 'POST /api/avatar/generate',
            status: 'success',
            req: req,
            details: { textModel: cleanGlobalModel, imageModel: cleanAvatarModel }
        });

        console.log(`[AvatarGenerator] Successfully generated and updated avatar for ${userEmail}`);
        res.json({ success: true, avatarUrl });

    } catch (err) {
        console.error("[AvatarGenerator] Error generating avatar:", err);
        auditDb.logEvent({
            userId: userId,
            userEmail: userEmail,
            eventType: 'avatar_generation',
            action: 'POST /api/avatar/generate',
            status: 'failure',
            req: req,
            details: { error: err.message }
        });
        res.status(500).json({ error: err.message || 'Failed to generate avatar' });
    }
});



// ... (Top of file needs googleapis import if not present, but it is likely there or we use raw fetch)
// Retrieving 'google' from googleapis is needed for Drive API usage inside the job.
// Google Drive API endpoints (google import moved to top)

app.post('/api/gemini', requireAuth, async (req, res) => {
    const { message, history, config, images, previous_interaction_id, environment_id, workflowDefinitionId } = req.body;
    try {
        const allowedWidgets = req.user.allowed_widgets || [];
        const isAvatarCreation = config?.isAvatarGeneration === true || config?.mode === 'nanobanana' || (Array.isArray(images) && images.length > 0 && typeof message === 'string' && message.includes('アバター'));
        const hasGeminiAccess = allowedWidgets.includes('*') || allowedWidgets.includes('app:gemini');

        if (!hasGeminiAccess && !isAvatarCreation) {
            auditDb.logEvent({
                userId: req.user.id,
                userEmail: req.user.email,
                eventType: 'permission_denied',
                action: `${req.method} ${req.originalUrl}`,
                status: 'blocked',
                req: req,
                details: { requiredWidget: 'app:gemini' }
            });
            return res.status(403).json({ error: 'Access denied. Requires widget access: app:gemini' });
        }

        const geminiApiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const configuredProvider = config?.provider || (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !geminiApiKey ? 'claude' : 'gemini');

        const globalGeminiModel = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
        const globalClaudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
        const mode = config?.mode || 'rag';

        if (mode === 'nanobanana' && !geminiApiKey) {
            return res.status(400).json({
                error: '⚠️ インフォグラフィック・画像生成（NanoBanana）は Google Gemini 専用機能です。利用するには System Settings で Gemini API Key を設定してください。',
                geminiOnly: true
            });
        }

        // Retrieve custom workflow settings if provided
        let customWorkflow = null;
        if (workflowDefinitionId) {
            customWorkflow = await new Promise((resolve) => {
                db.get("SELECT * FROM deep_research_workflow_definitions WHERE id = ?", [workflowDefinitionId], (err, row) => {
                    resolve(row || null);
                });
            });
        }

        // ZTA: Enforce Model Access (PEP)
        // Normal Chat ('normal', 'rag', 'search') strictly uses the Admin-configured default model from System Settings
        const adminDefaultChatModel = configuredProvider === 'claude' ? globalClaudeModel : globalGeminiModel;
        let requestedModel = adminDefaultChatModel;
        if (mode === 'research') {
            const defaultResModel = configuredProvider === 'claude'
                ? (await db.getSetting('CLAUDE_RESEARCH_MODEL') || globalClaudeModel)
                : (await db.getSetting('GEMINI_RESEARCH_MODEL') || globalGeminiModel);
            requestedModel = customWorkflow?.research_model || config?.model || defaultResModel;
        } else if (mode === 'nanobanana') {
            requestedModel = customWorkflow?.output_model || await db.getSetting('GEMINI_NANO_BANANA_MODEL') || globalGeminiModel;
        } else if (mode === 'html_svg') {
            const defaultHtmlModel = configuredProvider === 'claude'
                ? (await db.getSetting('CLAUDE_HTML_SVG_MODEL') || globalClaudeModel)
                : (await db.getSetting('GEMINI_HTML_SVG_MODEL') || globalGeminiModel);
            requestedModel = customWorkflow?.output_model || config?.model || defaultHtmlModel;
        }

        // Fallback if selected provider key is missing but the other provider key is configured
        if (mode !== 'nanobanana') {
            if (llmAdapter.isClaudeModel(requestedModel) && !claudeApiKey && geminiApiKey) {
                requestedModel = globalGeminiModel;
            } else if (!llmAdapter.isClaudeModel(requestedModel) && !geminiApiKey && claudeApiKey) {
                requestedModel = globalClaudeModel;
            }
        }

        const isTargetClaude = mode !== 'nanobanana' && llmAdapter.isClaudeModel(requestedModel);
        if (isTargetClaude && !claudeApiKey) {
            return res.status(400).json({ error: 'Claude API Key が設定されていません。System Settings で Claude API Key を設定してください。' });
        }
        if (!isTargetClaude && !geminiApiKey) {
            return res.status(400).json({ error: 'Gemini API Key が設定されていません。System Settings で Gemini API Key を設定してください。' });
        }

        const allowedModels = req.user.allowed_models || [];
        const cleanRequestedModel = requestedModel.replace(/^models\//, '');
        const hasDirectModelAccess = llmAdapter.isModelAllowedForUser(
            requestedModel,
            allowedModels,
            [globalGeminiModel, globalClaudeModel]
        );
            
        const isAvatarCreationModel = isAvatarCreation && (
            requestedModel === globalGeminiModel || 
            cleanRequestedModel === globalGeminiModel.replace(/^models\//, '') ||
            requestedModel === (await db.getSetting('GEMINI_NANO_BANANA_MODEL')) ||
            cleanRequestedModel === (await db.getSetting('GEMINI_NANO_BANANA_MODEL'))?.replace(/^models\//, '')
        );

        if (!hasDirectModelAccess && !isAvatarCreationModel) {
            return res.status(403).json({ error: `Access denied. Requires model access: ${requestedModel}` });
        }

        // ZTA: Enforce Fine-Grained Personal RAG Access (PEP)
        if (mode === 'rag') {
            const targetFolderId = config?.targetRagFolderId;
            const hasRagAccess = allowedWidgets.includes('*') || (targetFolderId && allowedWidgets.includes(`rag:${targetFolderId}`));
            if (!hasRagAccess) {
                auditDb.logEvent({
                    userId: req.user.id,
                    userEmail: req.user.email,
                    eventType: 'permission_denied',
                    action: `POST /api/gemini (RAG: ${targetFolderId || 'unspecified'})`,
                    status: 'blocked',
                    req: req,
                    details: { requiredPermission: targetFolderId ? `rag:${targetFolderId}` : 'rag:*' }
                });
                return res.status(403).json({ error: `Access denied. Requires RAG folder access: ${targetFolderId ? `rag:${targetFolderId}` : 'rag:*'}` });
            }
        }

        const crypto = require('crypto');
        const jobId = crypto.randomUUID();

        // Start background job
        processGeminiJob(jobId, message, history, geminiApiKey, requestedModel, config, req.user.googleId, images, previous_interaction_id, environment_id, workflowDefinitionId, claudeApiKey);

        // Track RAG query usage for FAQ feature
        if (config?.mode === 'rag' && message.trim()) {
            db.run(
                `INSERT INTO rag_queries (query_text) VALUES (?)
                 ON CONFLICT(query_text) DO UPDATE SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP`,
                [message.trim()],
                (err) => {
                    if (err) console.error("Failed to track RAG query:", err);
                }
            );
        }

        res.json({ jobId, status: 'processing' });

    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ...

// Background Gemini / Claude Job Processor
async function processGeminiJob(jobId, message, history, apiKey, modelName, customConfig, googleId, images, previous_interaction_id, environment_id, workflowDefinitionId, claudeApiKeyParam) {
    geminiJobs[jobId] = { state: 'processing', reply: null, error: null, googleId };
    console.log(`Starting AI Job ${jobId}...`);
    console.log(`Job Config: mode=${customConfig?.mode}, grounding=${customConfig?.grounding}, model=${modelName}`);

    try {
        let mode = customConfig?.mode || 'rag'; // Default to RAG
        const claudeApiKey = claudeApiKeyParam || await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const aiProvider = customConfig?.provider || (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

        // Retrieve custom workflow settings if provided
        let customWorkflow = null;
        if (workflowDefinitionId) {
            customWorkflow = await new Promise((resolve) => {
                db.get("SELECT * FROM deep_research_workflow_definitions WHERE id = ?", [workflowDefinitionId], (err, row) => {
                    resolve(row || null);
                });
            });
        }

        const globalGeminiModel = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
        const globalClaudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';

        // Deep Research / Output Mode model resolution (respecting Claude models if selected)
        if (mode === 'research') {
            const defaultRes = llmAdapter.isClaudeModel(modelName) || aiProvider === 'claude'
                ? (await db.getSetting('CLAUDE_RESEARCH_MODEL') || globalClaudeModel)
                : (await db.getSetting('GEMINI_RESEARCH_MODEL') || globalGeminiModel);
            const configuredResearchModel = customWorkflow?.research_model || customConfig?.model || defaultRes;
            modelName = configuredResearchModel;
            console.log(`Research Mode Activated: Enforcing model ${modelName}`);
        } else if (mode === 'nanobanana') {
            const configuredNanoModel = customWorkflow?.output_model || await db.getSetting('GEMINI_NANO_BANANA_MODEL');
            modelName = configuredNanoModel || globalGeminiModel;
            console.log(`Nano Banana Mode Activated: Enforcing model ${modelName}`);
        } else if (mode === 'html_svg') {
            const defaultHtml = llmAdapter.isClaudeModel(modelName) || aiProvider === 'claude'
                ? (await db.getSetting('CLAUDE_HTML_SVG_MODEL') || globalClaudeModel)
                : (await db.getSetting('GEMINI_HTML_SVG_MODEL') || globalGeminiModel);
            const configuredHtmlSvgModel = customWorkflow?.output_model || customConfig?.model || defaultHtml;
            modelName = configuredHtmlSvgModel;
            console.log(`HTML/SVG Mode Activated: Enforcing model ${modelName}`);
        }

        const useClaude = mode !== 'nanobanana' && (llmAdapter.isClaudeModel(modelName) || (!apiKey && !!claudeApiKey));

        // Get RAG files (if mode is 'rag' or 'research')
        let ragFiles = [];
        let sourceInfo = {
            type: 'general_knowledge',
            label: '🧠 パブリック一般知識 (事前学習モデル)',
            sources: []
        };

        if (mode === 'rag' || mode === 'research') {
            const targetFolderId = customConfig?.targetRagFolderId;
            ragFiles = await new Promise((resolve) => {
                // For Gemini File API, limit to 40h unless using Claude with local_cache_path
                const expirationLimit = new Date(Date.now() - (useClaude ? 365 * 24 : 40) * 60 * 60 * 1000).toISOString();
                let query = "SELECT gemini_file_uri, drive_file_id, file_name, mime_type, local_cache_path FROM rag_files WHERE datetime(last_synced_at) > datetime(?)";
                let params = [expirationLimit];
                
                if (mode === 'rag' && targetFolderId) {
                    query += " AND folder_id = ?";
                    params.push(targetFolderId);
                }
                
                db.all(query, params, (err, rows) => {
                    if (err) resolve([]);
                    else resolve(rows || []);
                });
            });

            if (mode === 'rag') {
                if (ragFiles.length > 0) {
                    sourceInfo = {
                        type: 'google_drive',
                        label: '📚 Google Drive (Personal RAG)',
                        folderId: targetFolderId,
                        sources: ragFiles.map(f => ({
                            name: f.file_name || f.drive_file_id,
                            fileId: f.drive_file_id,
                            mimeType: f.mime_type
                        }))
                    };
                } else {
                    sourceInfo = {
                        type: 'general_knowledge',
                        warning: 'RAG_EMPTY',
                        label: '⚠️ Google Drive 未同期 (パブリック知識)',
                        sources: []
                    };
                }
            }
        } else if (mode === 'normal' && customConfig?.grounding) {
            sourceInfo = {
                type: 'google_search',
                label: '🌐 Google Search (パブリックWeb検索)',
                sources: []
            };
        } else if (mode === 'local_rag' || mode === 'gemma4') {
            sourceInfo = {
                type: 'local_ai',
                label: '🛡️ Local Gemma 4',
                sources: []
            };
        }

        let requestParts = [{ text: message }];

        if (images && Array.isArray(images)) {
            const imageParts = images.map(img => ({
                inlineData: {
                    data: img.data,
                    mimeType: img.mimeType || 'image/png'
                }
            }));
            requestParts = [...imageParts, ...requestParts];
        }

        if (ragFiles.length > 0) {
            const fileParts = ragFiles.map(f => ({
                fileData: {
                    mimeType: f.mime_type || 'application/pdf',
                    fileUri: f.gemini_file_uri
                }
            }));
            requestParts = [...fileParts, ...requestParts];
        }

        // Legacy compatibility for nanobanana mode
        const contents = history ? history.map(m => ({
            role: m.role,
            parts: m.parts
        })) : [];

        contents.push({
            role: 'user',
            parts: requestParts
        });

        // Dedicated System Instruction
        let systemInstruction = undefined;

        if (customConfig?.systemInstruction) {
            systemInstruction = customConfig.systemInstruction;
        } else if (mode === 'rag' && ragFiles.length > 0) {
            const fileNames = ragFiles.map(f => f.file_name || f.drive_file_id).join(', ');
            systemInstruction = `あなたは Google Drive から同期された社内ドキュメントを参照して回答する専門アシスタントです。\n提供された添付資料（${fileNames}）の内容を最優先とし、そこに書かれている定義や事実に基づいて正確に回答してください。\n回答の文脈の中で、どのドキュメントを参照したかを明記してください。`;
        } else if (mode === 'rag' && ragFiles.length === 0) {
            systemInstruction = "【注意】指定された Google Drive フォルダには同期済みドキュメントが存在しませんでした。Gemini のパブリックな一般知識に基づいて回答してください。回答の冒頭に「※ Google Drive 内に対象ドキュメントが見つからないため、一般知識に基づいて回答します」と明記してください。";
        } else if (mode === 'normal' && customConfig?.grounding) {
            systemInstruction = "You have access to Google Search. ALWAYS use Google Search for any questions about current events, people, or facts that might have changed since your training data. Prioritize information from search results over your internal knowledge.";
        } else if (mode === 'research') {
             const customResearchPrompt = customWorkflow?.research_prompt || await db.getSetting('DEEP_RESEARCH_PROMPT');
             systemInstruction = customResearchPrompt || "あなたは世界最高峰のリサーチャーです。提出された社内資料（RAGファイル）と、最新のWeb検索結果（Google Search）の両方を駆使して、包括的でインサイトに富んだ長文の調査レポートを作成してください。必要に応じて、検索した結果や考察を整理し、Markdownフォーマットで見やすく構造化すること。\n\n【重要事項】ユーザーから「ファイルに保存して」と頼まれても、あなたが直接ファイル操作やダウンロードリンクの生成をする必要はありません。あなたがチャットに出力したMarkdownのテキストは、システム側で自動的にGoogle Driveへファイルとして保存・エクスポートされる仕組みが備わっています。そのため、「ファイルとして保存できませんのでコピーしてください」などの謝罪や案案内は一切書かずに、ただ自信を持ってMarkdownレポートの本文のみを堂々と出力してください。";
        }

        // Configure Tools based on mode
        const tools = [];
        if (mode === 'search' || mode === 'research' || (mode === 'normal' && customConfig?.grounding)) {
            tools.push({ type: "google_search" });
        }

        if (mode === 'search') {
            // Add Save to Drive tool definition
            tools.push({
                type: "function",
                name: "save_to_drive",
                description: "Save a file (Research Report, Article, etc.) to Google Drive. Use this to save the result of your research.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        filename: {
                            type: "STRING",
                            description: "The name of the file to save (e.g., 'Research_Report_Containers.md')."
                        },
                        content: {
                            type: "STRING",
                            description: "The text content to save into the file."
                        },
                        mimeType: {
                            type: "STRING",
                            description: "MIME type of the file. Defaults to 'text/markdown'.",
                            enum: ["text/plain", "text/markdown", "application/json"]
                        }
                    },
                    required: ["filename", "content"]
                }
            });
        }

        const config = {
            temperature: customConfig?.temperature ?? 0.7,
            maxOutputTokens: customConfig?.maxOutputTokens ?? 32768,
            topP: customConfig?.topP,
            topK: customConfig?.topK,
            tools: tools.length > 0 ? tools : undefined,
            systemInstruction: systemInstruction
        };

        // Add thinkingConfig for Gemini 3.1 Pro to improve grounding and reasoning
        if (mode === 'research' || (mode === 'normal' && customConfig?.grounding)) {
            let level = customConfig?.thinkingLevel || 'HIGH';
            if (level === 'DEFAULT' || level === 'STANDARD') level = 'MEDIUM'; // 'STANDARD' is invalid for 3.1 Pro, use 'MEDIUM'

            // Note: The officially supported strings for Gemini 3.1 Pro are: "LOW", "MEDIUM", "HIGH"
            console.log("Setting thinking level to", level);
            config.thinkingConfig = { thinkingLevel: level };
        }

        // Retrieve token for tools execution
        const accessToken = await new Promise((resolve) => {
            db.get("SELECT access_token FROM users WHERE google_id = ?", [googleId], (err, row) => {
                if (err || !row) resolve(null);
                else resolve(row.access_token);
            });
        });

        // 0. Anthropic Claude Execution Path (Normal / RAG / Search / Research / HTML_SVG)
        if (useClaude) {
            if (!claudeApiKey) {
                throw new Error("Claude API Key が設定されていません。System Settings で Claude API Key を設定してください。");
            }

            console.log(`Executing job ${jobId} via Anthropic Claude (${modelName}) in mode=${mode}...`);

            const enableWebSearch = mode === 'search' || mode === 'research' || (mode === 'normal' && !!customConfig?.grounding);
            const enableDriveSaveTool = mode === 'search';

            const saveToDriveCallback = async ({ filename, content, mimeType }) => {
                const folderId = await db.getSetting('GEMINI_RESEARCH_FOLDER_ID');
                if (!folderId) {
                    return { error: "Research Folder ID not configured in System Settings." };
                }
                if (!accessToken) {
                    return { error: "User authorization missing. Cannot save to Drive." };
                }
                const { google } = require('googleapis');
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: decrypt(accessToken) });
                const drive = google.drive({ version: 'v3', auth });

                const res = await drive.files.create({
                    requestBody: {
                        name: filename,
                        parents: [folderId],
                        mimeType: mimeType || 'text/markdown'
                    },
                    media: {
                        mimeType: mimeType || 'text/markdown',
                        body: content
                    }
                });
                return { success: true, fileId: res.data.id, message: `File '${filename}' saved successfully.` };
            };

            const claudeRes = await llmAdapter.runClaudeChatJob({
                apiKey: claudeApiKey,
                model: modelName,
                message,
                history,
                images,
                ragFiles,
                systemInstruction,
                temperature: customConfig?.temperature ?? 0.7,
                maxOutputTokens: customConfig?.maxOutputTokens ?? 16384,
                enableWebSearch,
                enableDriveSaveTool,
                saveToDriveCallback
            });

            let finalReply = claudeRes.reply || "No content generated.";

            // Deep Research Auto-Save to Drive for Claude as well
            if (mode === 'research' && claudeRes.reply) {
                try {
                    const folderId = await db.getSetting('GEMINI_RESEARCH_FOLDER_ID');
                    if (folderId && googleId) {
                        const userRow = await new Promise((resolve, reject) => {
                            db.get("SELECT access_token, refresh_token FROM users WHERE google_id = ?", [googleId], (err, row) => {
                                if (err) reject(err);
                                else resolve(row);
                            });
                        });
                        if (userRow && userRow.access_token) {
                            const { google } = require('googleapis');
                            const oAuth2Client = await getOAuthClient();
                            oAuth2Client.setCredentials({
                                access_token: userRow.access_token,
                                refresh_token: userRow.refresh_token
                            });
                            const drive = google.drive({ version: 'v3', auth: oAuth2Client });
                            const dateStr = new Date().toISOString().split('T')[0];
                            const filename = `DeepResearch_Report_${dateStr}_${Date.now()}.md`;
                            try {
                                await drive.files.create({
                                    requestBody: { name: filename, parents: [folderId], mimeType: 'text/markdown' },
                                    media: { mimeType: 'text/markdown', body: claudeRes.reply },
                                    supportsAllDrives: true
                                });
                                finalReply += `\n\n---\n✅ **System Notification:** \nResearch report has been successfully saved to your Google Drive folder as \`${filename}\`.`;
                            } catch (folderErr) {
                                await drive.files.create({
                                    requestBody: { name: filename, mimeType: 'text/markdown' },
                                    media: { mimeType: 'text/markdown', body: claudeRes.reply }
                                });
                                finalReply += `\n\n---\n⚠️ **System Notification:** \nCould not access the specified folder (ID: ${folderId}). The research report was saved to the root of your Google Drive as \`${filename}\`.`;
                            }
                        }
                    }
                } catch (err) {
                    console.error("Failed to auto-save Claude research to drive:", err);
                    finalReply += `\n\n---\n⚠️ **System Notification:** \nCould not save the research report to Google Drive. Error: ${err.message}`;
                }
            }

            geminiJobs[jobId] = {
                ...geminiJobs[jobId],
                state: 'completed',
                reply: finalReply,
                usageMetadata: claudeRes.usageMetadata,
                sourceInfo,
                provider: 'claude',
                model: modelName,
                error: null,
                interactionId: claudeRes.interactionId,
                environmentId: 'anthropic'
            };
            console.log(`Claude Job ${jobId} completed.`);
            return;
        }

        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 600000 } });

        // 1. Nanobanana (Image Generation) Mode
        if (mode === 'nanobanana') {
            const timeoutMs = 120000;
            const createTimeout = () => new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini API Request Timeout (120s)")), timeoutMs));

            console.log(`Sending request to Gemini for Image Generation using model: ${modelName}...`);
            
            // Extract the string prompt from contents
            let promptText = "";
            if (typeof message === 'string') {
                promptText = message;
            } else if (Array.isArray(contents)) {
                promptText = contents.map(c => c.text || "").join(' ');
            }
            
            let base64Data = null;

            // Strategy A: If it's an imagen model, try client.models.generateImages
            if (modelName.includes('imagen')) {
                try {
                    const result = await Promise.race([
                        client.models.generateImages({
                            model: modelName,
                            prompt: promptText,
                            config: {
                                numberOfImages: 1,
                                outputMimeType: "image/png",
                                aspectRatio: customConfig?.aspectRatio || "1:1"
                            }
                        }),
                        createTimeout()
                    ]);
                    const generatedImage = result.generatedImages?.[0]?.image;
                    if (generatedImage && generatedImage.imageBytes) {
                        base64Data = generatedImage.imageBytes;
                    }
                } catch (err) {
                    console.warn(`generateImages failed for ${modelName} (${err.message}). Falling back to generateContent with responseModalities: ['IMAGE']...`);
                }
            }

            // Strategy B: Fallback / standard multimodal image generation via generateContent
            if (!base64Data) {
                const targetModel = modelName.includes('imagen') ? globalGeminiModel : modelName;
                console.log(`Executing generateContent with responseModalities: ['IMAGE'] on model ${targetModel}...`);
                const result = await Promise.race([
                    client.models.generateContent({
                        model: targetModel,
                        contents: promptText,
                        config: {
                            responseModalities: ['IMAGE']
                        }
                    }),
                    createTimeout()
                ]);

                const candidates = result.candidates || [];
                const parts = candidates[0]?.content?.parts || [];
                const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
                if (imagePart) {
                    base64Data = imagePart.inlineData.data;
                }
            }

            if (base64Data) {
                geminiJobs[jobId] = {
                    ...geminiJobs[jobId],
                    state: 'completed',
                    reply: JSON.stringify({ type: 'image', mimeType: 'image/png', data: base64Data }),
                    error: null
                };
                console.log(`Gemini Job ${jobId} completed. (Image generated successfully)`);
                return; // Successfully finished
            } else {
                throw new Error("No image data returned from model.");
            }
        }

        // 1.5. HTML/SVG Generation Mode uses stateless Models API with Streaming
        if (mode === 'html_svg') {
            const timeoutMs = 120000; // 120s timeout
            const createTimeout = () => new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini API Request Timeout (120s)")), timeoutMs));

            console.log("Sending request to Gemini (Models API Stream) for HTML/SVG Generation...");
            const streamResult = await Promise.race([
                client.models.generateContentStream({
                    model: modelName,
                    contents: contents,
                    config: {
                        temperature: customConfig?.temperature ?? 0.7,
                        maxOutputTokens: customConfig?.maxOutputTokens ?? 32768,
                        topP: customConfig?.topP,
                        topK: customConfig?.topK,
                        systemInstruction: systemInstruction
                    }
                }),
                createTimeout()
            ]);

            let responseText = "";
            let fullResult = null;

            const consumeStream = async () => {
                for await (const chunk of streamResult) {
                    if (chunk.text) {
                        responseText += chunk.text;
                    }
                    fullResult = chunk;
                }
            };

            await Promise.race([consumeStream(), createTimeout()]);

            if (responseText) {
                const usageMetadata = fullResult?.usageMetadata || null;
                geminiJobs[jobId] = {
                    ...geminiJobs[jobId],
                    state: 'completed',
                    reply: responseText,
                    usageMetadata,
                    error: null
                };
                console.log(`Gemini Job ${jobId} completed (HTML/SVG generated stateless).`);
                return;
            } else {
                throw new Error("No content generated.");
            }
        }

        // 2. Chat / Search / Research Mode uses stateful Interactions API with streaming
        let currentInteractionId = previous_interaction_id;
        let currentEnvironmentId = environment_id;

        let maxTurns = 5; // Prevent infinite loops
        let fullInteraction = null;
        let responseText = "";

        while (maxTurns > 0) {
            maxTurns--;
            console.log(`Gemini Interactions Turn: ${5 - maxTurns}`);

            let turnResponseText = "";
            let streamResult = null;
            let currentRetries = 3;
            let success = false;

            while (currentRetries > 0 && !success) {
                try {
                    const timeoutMs = 300000; // 300s timeout
                    const createTimeout = () => new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini API Request Timeout (300s)")), timeoutMs));

                    console.log("Sending request to Gemini Interactions (Stream)...");
                    
                    const interactionInput = [{
                        type: "user_input",
                        content: requestParts.map(part => {
                            if (part.text !== undefined) {
                                return { type: "text", text: part.text };
                            } else if (part.inlineData) {
                                return {
                                    type: "image",
                                    data: part.inlineData.data,
                                    mime_type: part.inlineData.mimeType
                                };
                            } else if (part.fileData) {
                                return {
                                    type: part.fileData.mimeType?.startsWith('image/') ? 'image' : 'document',
                                    mime_type: part.fileData.mimeType,
                                    uri: part.fileData.fileUri
                                };
                            }
                            return null;
                        }).filter(Boolean)
                    }];

                    streamResult = await Promise.race([
                        client.interactions.create({
                            model: modelName,
                            input: interactionInput,
                            previous_interaction_id: currentInteractionId || undefined,
                            environment: currentEnvironmentId || "remote",
                            stream: true,
                            system_instruction: config.systemInstruction,
                            tools: config.tools,
                            generation_config: {
                                temperature: config.temperature,
                                max_output_tokens: config.maxOutputTokens,
                                top_p: config.topP,
                                top_k: config.topK,
                                thinking_level: (config.thinkingConfig && (modelName.includes('thinking') || modelName.includes('pro'))) ? 
                                    config.thinkingConfig.thinkingLevel.toLowerCase() : undefined
                            }
                        }),
                        createTimeout()
                    ]);

                    const consumeStream = async () => {
                        for await (const event of streamResult) {
                            if (event.event_type === "interaction.created" && event.interaction) {
                                currentInteractionId = event.interaction.id;
                                currentEnvironmentId = event.interaction.environment_id;
                                fullInteraction = event.interaction;
                            }
                            if (event.event_type === 'step.delta' && event.delta?.type === 'text') {
                                turnResponseText += event.delta.text;
                                responseText += event.delta.text;
                            }
                            if (event.interaction) {
                                fullInteraction = event.interaction;
                            }
                        }
                    };

                    await Promise.race([consumeStream(), createTimeout()]);
                    success = true;

                } catch (apiError) {
                    console.error(`Gemini API Error (Retries left: ${currentRetries - 1}):`, apiError);

                    const isTimeout = apiError.message && apiError.message.includes('Timeout');
                    const isOverloaded = apiError.status === 503 || (apiError.message && apiError.message.includes('Overloaded'));

                    if (currentRetries > 1 && (isTimeout || isOverloaded)) {
                        currentRetries--;
                        await new Promise(res => setTimeout(res, 3000)); // Wait a bit longer before retry
                    } else {
                        throw apiError;
                    }
                }
            }

            if (currentInteractionId) {
                fullInteraction = await client.interactions.get(currentInteractionId);
            }

            if (!fullInteraction) {
                throw new Error("Failed to retrieve interaction state.");
            }

            const steps = fullInteraction.steps || [];
            const lastStep = steps[steps.length - 1];

            if (lastStep && lastStep.type === 'function_call') {
                const functionCalls = lastStep.content.filter(p => p.functionCall);
                if (functionCalls.length > 0) {
                    const functionResponses = [];
                    for (const call of functionCalls) {
                        const funcName = call.functionCall.name;
                        const funcArgs = call.functionCall.args || {};
                        const funcId = call.functionCall.id;

                        console.log(`Executing Tool: ${funcName}`);
                        if (funcName === 'save_to_drive') {
                            try {
                                const { filename, content, mimeType } = funcArgs;
                                const folderId = await db.getSetting('GEMINI_RESEARCH_FOLDER_ID');

                                if (!folderId) {
                                    functionResponses.push({
                                        functionResponse: {
                                            name: funcName,
                                            id: funcId,
                                            response: { error: "Research Folder ID not configured in System Settings." }
                                        }
                                    });
                                    continue;
                                }

                                if (!accessToken) {
                                    throw new Error("User authorization missing. Cannot save to Drive.");
                                }

                                // Create Drive Client
                                const { google } = require('googleapis');
                                const auth = new google.auth.OAuth2();
                                auth.setCredentials({ access_token: decrypt(accessToken) });
                                const drive = google.drive({ version: 'v3', auth });

                                const res = await drive.files.create({
                                    requestBody: {
                                        name: filename,
                                        parents: [folderId],
                                        mimeType: mimeType || 'text/markdown'
                                    },
                                    media: {
                                        mimeType: mimeType || 'text/markdown',
                                        body: content
                                    }
                                });

                                console.log(`Saved file: ${filename} (ID: ${res.data.id})`);
                                functionResponses.push({
                                    functionResponse: {
                                        name: funcName,
                                        id: funcId,
                                        response: { success: true, fileId: res.data.id, message: `File '${filename}' saved successfully.` }
                                    }
                                });

                            } catch (toolErr) {
                                console.error("Tool Execution Error:", toolErr);
                                functionResponses.push({
                                    functionResponse: {
                                        name: funcName,
                                        id: funcId,
                                        response: { error: "Failed to save file: " + toolErr.message }
                                    }
                                });
                            }
                        } else {
                            functionResponses.push({
                                functionResponse: {
                                    name: funcName,
                                    id: funcId,
                                    response: { error: "Unknown tool" }
                                }
                            });
                        }
                    }

                    // For the next turn, the input will be the function responses
                    requestParts = functionResponses;
                } else {
                    break;
                }
            } else {
                // normal output completion
                if (responseText) {
                    const usageMetadata = fullInteraction?.usage || fullInteraction?.usage_metadata || fullInteraction?.usageMetadata || null;
                    geminiJobs[jobId] = { 
                        ...geminiJobs[jobId], 
                        state: 'completed', 
                        reply: responseText, 
                        usageMetadata, 
                        sourceInfo,
                        error: null,
                        interactionId: currentInteractionId,
                        environmentId: currentEnvironmentId
                    };
                    console.log(`Gemini Job ${jobId} completed.`);

                    // Deep Research Auto-Save to Drive
                    if (mode === 'research') {
                        try {
                            const folderId = await db.getSetting('GEMINI_RESEARCH_FOLDER_ID');
                            if (folderId && googleId) {
                                // Fetch OAuth tokens from DB
                                const userRow = await new Promise((resolve, reject) => {
                                    db.get("SELECT access_token, refresh_token FROM users WHERE google_id = ?", [googleId], (err, row) => {
                                        if (err) reject(err);
                                        else resolve(row);
                                    });
                                });

                                if (!userRow || !userRow.access_token) {
                                    throw new Error("Google Drive access token not found. Please log in again from the settings menu.");
                                }

                                const { google } = require('googleapis');
                                const oAuth2Client = await getOAuthClient();
                                oAuth2Client.setCredentials({
                                    access_token: userRow.access_token,
                                    refresh_token: userRow.refresh_token
                                });

                                // Listen for token refreshes to keep DB updated
                                oAuth2Client.on('tokens', (tokens) => {
                                    if (tokens.access_token) {
                                        const updateSql = `UPDATE users SET access_token = ?` + (tokens.refresh_token ? `, refresh_token = ?` : ``) + ` WHERE google_id = ?`;
                                        const params = [tokens.access_token];
                                        if (tokens.refresh_token) params.push(tokens.refresh_token);
                                        params.push(googleId);
                                        db.run(updateSql, params, (err) => {
                                            if (err) console.error("Failed to update refreshed tokens in DB during Deep Research:", err);
                                        });
                                    }
                                });

                                const drive = google.drive({ version: 'v3', auth: oAuth2Client });

                                const dateStr = new Date().toISOString().split('T')[0];
                                const filename = `DeepResearch_Report_${dateStr}_${Date.now()}.md`;

                                try {
                                    // 1st attempt: Save to the specified folder
                                    await drive.files.create({
                                        requestBody: {
                                            name: filename,
                                            parents: [folderId],
                                            mimeType: 'text/markdown'
                                        },
                                        media: {
                                            mimeType: 'text/markdown',
                                            body: responseText
                                        },
                                        supportsAllDrives: true
                                    });
                                    console.log(`Auto-saved research result to Drive folder ${folderId} as ${filename}`);
                                    geminiJobs[jobId].reply += `\n\n---\n✅ **System Notification:** \nResearch report has been successfully saved to your Google Drive folder as \`${filename}\`.`;
                                } catch (folderErr) {
                                    // Fallback: Save to root if the folder is not found or inaccessible (e.g. 404 error)
                                    console.warn(`Failed to save to specific folder ${folderId}. Falling back to root directory. Error:`, folderErr.message);

                                    await drive.files.create({
                                        requestBody: {
                                            name: filename,
                                            mimeType: 'text/markdown'
                                        },
                                        media: {
                                            mimeType: 'text/markdown',
                                            body: responseText
                                        }
                                    });
                                    console.log(`Auto-saved research result to Drive root as ${filename}`);
                                    geminiJobs[jobId].reply += `\n\n---\n⚠️ **System Notification:** \nCould not access the specified folder (ID: ${folderId}). The research report was saved to the root of your Google Drive as \`${filename}\`.`;
                                }
                            }
                        } catch (err) {
                            console.error("Failed to auto-save research to drive:", err);
                            geminiJobs[jobId].reply += `\n\n---\n⚠️ **System Notification:** \nCould not save the research report to Google Drive. Error: ${err.message}`;
                        }
                    }

                    return;
                } else {
                    geminiJobs[jobId] = { 
                        ...geminiJobs[jobId], 
                        state: 'completed', 
                        reply: "No content generated.", 
                        error: null,
                        interactionId: currentInteractionId,
                        environmentId: currentEnvironmentId
                    };
                    return;
                }
            }
        }

        geminiJobs[jobId] = { ...geminiJobs[jobId], state: 'error', reply: null, error: "Max turns exceeded" };

    } catch (error) {
        console.error(`Gemini Job ${jobId} Failed:`, error);
        geminiJobs[jobId] = { ...geminiJobs[jobId], state: 'error', reply: null, error: error.message };
    }
}

// Global sync status
let ragSyncStatus = {
    state: 'idle', // idle, syncing, completed, error
    progress: 0,
    total: 0,
    currentFile: '',
    error: null,
    errors: []
};

// Recursive helper to list all files from a folder and its subfolders
async function listFolderFilesRecursively(drive, folderId, folderName, maxDepth = 2, currentDepth = 0) {
    let results = [];
    try {
        const driveRes = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false and (mimeType = 'application/pdf' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/csv' or mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.folder')`,
            fields: 'files(id, name, mimeType, modifiedTime)',
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: 'allDrives'
        });

        const files = driveRes.data.files || [];
        for (const item of files) {
            if (item.mimeType === 'application/vnd.google-apps.folder') {
                if (currentDepth < maxDepth) {
                    const subFiles = await listFolderFilesRecursively(drive, item.id, item.name, maxDepth, currentDepth + 1);
                    results = results.concat(subFiles);
                }
            } else {
                results.push(item);
            }
        }
    } catch (folderErr) {
        console.error(`Failed to list files for folder ${folderName} (${folderId}):`, folderErr.message);
    }
    return results;
}

// Background Sync Function
async function performRagSync(drive, ragFolders, apiKey, syncTarget = 'all') {
    ragSyncStatus = { state: 'syncing', target: syncTarget, progress: 0, total: 0, currentFile: 'Starting...', error: null, errors: [] };
    console.log(`Starting background RAG sync for multiple folders (target: ${syncTarget})...`);

    try {
        const client = (syncTarget !== 'claude' && apiKey) ? new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } }) : null;
        const ragCacheDir = path.resolve(__dirname, '../data/rag_cache');
        if (!fs.existsSync(ragCacheDir)) {
            fs.mkdirSync(ragCacheDir, { recursive: true });
        }

        let allDriveFiles = [];
        let folderIdMap = new Map(); // drive_file_id -> folder_id

        // 1. List files for all folders (including subfolders for Shared Drives)
        ragSyncStatus.currentFile = 'Listing files...';
        let folderErrors = [];
        for (const folder of ragFolders) {
            const files = await listFolderFilesRecursively(drive, folder.id, folder.name);
            if (files.length === 0) {
                folderErrors.push(`${folder.name}: no files found or folder inaccessible`);
            }
            allDriveFiles = allDriveFiles.concat(files);
            files.forEach(f => folderIdMap.set(f.id, folder.id));
        }

        // Deduplicate drive files
        const uniqueDriveFilesMap = new Map();
        allDriveFiles.forEach(f => uniqueDriveFilesMap.set(f.id, f));
        const uniqueDriveFiles = Array.from(uniqueDriveFilesMap.values());

        ragSyncStatus.total = uniqueDriveFiles.length;
        console.log(`Found ${uniqueDriveFiles.length} files to sync across ${ragFolders.length} folders.`);

        const currentDriveFileIds = uniqueDriveFiles.map(f => f.id);
        const syncedFiles = [];
        const syncErrors = [];

        for (let i = 0; i < uniqueDriveFiles.length; i++) {
            const file = uniqueDriveFiles[i];
            const currentFolderId = folderIdMap.get(file.id);
            ragSyncStatus.currentFile = `Syncing ${file.name} (${i + 1}/${uniqueDriveFiles.length})`;
            ragSyncStatus.progress = i + 1;
            console.log(`Syncing file: ${file.name} [Target: ${syncTarget}]`);

            try {
                // Download content
                let content;
                let mimeType = file.mimeType;
                let extension = '';

                if (file.mimeType === 'application/vnd.google-apps.document') {
                    const exportRes = await drive.files.export({
                        fileId: file.id,
                        mimeType: 'application/pdf'
                    }, { responseType: 'arraybuffer' });
                    content = Buffer.from(exportRes.data);
                    mimeType = 'application/pdf';
                    extension = 'pdf';
                } else {
                    const getRes = await drive.files.get({
                        fileId: file.id,
                        alt: 'media',
                        supportsAllDrives: true
                    }, { responseType: 'arraybuffer' });
                    content = Buffer.from(getRes.data);
                    if (mimeType === 'text/plain') extension = 'txt';
                    if (mimeType === 'text/markdown') extension = 'md';
                    if (mimeType === 'text/csv') extension = 'csv';
                    if (mimeType === 'application/pdf') extension = 'pdf';
                }

                // Save persistent local cache for Claude & offline RAG access
                const safeId = String(file.id).replace(/[^a-zA-Z0-9_-]/g, '_');
                const localCachePath = path.join(ragCacheDir, `${safeId}.${extension || 'bin'}`);
                fs.writeFileSync(localCachePath, content);

                // Fetch existing row to preserve existing URIs/caches
                const existingRow = await new Promise((res) => {
                    db.get("SELECT gemini_file_uri, local_cache_path FROM rag_files WHERE drive_file_id = ?", [file.id], (err, row) => res(row));
                });

                // Upload to Gemini File API if syncTarget is 'gemini' or 'all' and client is configured
                let geminiUri = existingRow?.gemini_file_uri || `local://${safeId}`;
                if (syncTarget !== 'claude' && client) {
                    const os = require('os');
                    const tempFilePath = path.join(os.tmpdir(), `gemini_upload_${safeId}.${extension}`);
                    try {
                        fs.writeFileSync(tempFilePath, content);
                        const uploadResult = await client.files.upload({
                            file: tempFilePath,
                            config: {
                                displayName: file.name,
                                mimeType: mimeType
                            }
                        });
                        geminiUri = uploadResult.uri;
                    } catch (geminiUploadErr) {
                        console.warn(`[RAG Sync] Gemini File API upload failed for ${file.name} (fallback to local cache for Claude):`, geminiUploadErr.message);
                        if (syncTarget === 'gemini') {
                            throw geminiUploadErr;
                        }
                    } finally {
                        if (fs.existsSync(tempFilePath)) {
                            try { fs.unlinkSync(tempFilePath); } catch (_) {}
                        }
                    }
                }

                // Store in DB (including local_cache_path)
                await new Promise((resolve, reject) => {
                    db.run(`INSERT OR REPLACE INTO rag_files (drive_file_id, gemini_file_uri, folder_id, file_name, mime_type, local_cache_path, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [file.id, geminiUri, currentFolderId, file.name, mimeType, localCachePath, new Date().toISOString()],
                        (err) => {
                            if (err) reject(err);
                            else resolve();
                        }
                    );
                });

                syncedFiles.push({ name: file.name, uri: geminiUri });

            } catch (fileErr) {
                console.error(`Failed to sync file ${file.name}:`, fileErr);
                syncErrors.push({ file: file.name, error: fileErr.message });
                // Continue to next file
            }
        }

        // Store last sync time per target
        const nowIso = new Date().toISOString();
        if (syncTarget === 'gemini' || syncTarget === 'all') {
            await db.setSetting('LAST_RAG_SYNC_TIME_GEMINI', nowIso);
        }
        if (syncTarget === 'claude' || syncTarget === 'all') {
            await db.setSetting('LAST_RAG_SYNC_TIME_CLAUDE', nowIso);
        }
        await db.setSetting('LAST_RAG_SYNC_TIME', nowIso);

        // 3. Clean up obsolete files from DB (files that are no longer in the Drive folder)
        if (currentDriveFileIds.length > 0) {
            const placeholders = currentDriveFileIds.map(() => '?').join(',');
            await new Promise((resolve, reject) => {
                db.run(`DELETE FROM rag_files WHERE drive_file_id NOT IN (${placeholders})`, currentDriveFileIds, (err) => {
                    if (err) {
                        console.error("Failed to cleanup obsolete RAG files:", err);
                        resolve(); // Non-fatal
                    } else {
                        console.log("Cleaned up obsolete RAG files from database.");
                        resolve();
                    }
                });
            });
        } else {
            // If drive folder is empty, clear the table
            await new Promise((resolve, reject) => {
                db.run("DELETE FROM rag_files", (err) => {
                    resolve();
                });
            });
        }

        ragSyncStatus.errors = syncErrors;
        ragSyncStatus.syncedCount = syncedFiles.length;
        if (folderErrors.length > 0 && uniqueDriveFiles.length === 0) {
            ragSyncStatus.state = 'error';
            ragSyncStatus.error = `Folder access error: ${folderErrors.join(', ')}`;
        } else {
            ragSyncStatus.state = 'completed';
            const targetLabel = syncTarget === 'gemini' ? 'Gemini Sync' : syncTarget === 'claude' ? 'Claude Sync' : 'Sync';
            ragSyncStatus.currentFile = uniqueDriveFiles.length === 0 ? `${targetLabel} Complete (0 files found)` : `${targetLabel} Complete (${syncedFiles.length} files synced)`;
        }
        console.log(`RAG sync completed (target: ${syncTarget}). Total synced:`, syncedFiles.length);

    } catch (error) {
        console.error("RAG Sync Fatal Error:", error);
        ragSyncStatus.state = 'error';
        ragSyncStatus.error = error.message;
    }
}

// RAG: Trigger Sync (Non-blocking)
app.post('/api/rag/sync', requireAuth, async (req, res) => {
    try {
        if (ragSyncStatus.state === 'syncing') {
            return res.status(409).json({ error: 'Sync already in progress' });
        }

        const syncTarget = req.body?.target || 'all'; // 'all' | 'gemini' | 'claude'
        const drive = await getDriveClient(req, res);
        if (!drive) return; // Response already sent

        let ragFolders = [];
        try {
            ragFolders = JSON.parse(await db.getSetting('GOOGLE_DRIVE_RAG_FOLDERS') || '[]');
        } catch (e) {
            ragFolders = [];
        }

        if (ragFolders.length === 0) {
            return res.status(400).json({ error: 'RAG Folders not configured' });
        }

        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        
        if (syncTarget === 'gemini' && !apiKey) {
            return res.status(400).json({ error: "Gemini API Key が設定されていません。" });
        }
        if (syncTarget === 'claude' && !claudeApiKey) {
            return res.status(400).json({ error: "Claude API Key が設定されていません。" });
        }
        if (syncTarget === 'all' && !apiKey && !claudeApiKey) {
            return res.status(400).json({ error: "GEMINI_API_KEY または CLAUDE_API_KEY が設定されていません。" });
        }

        // Start background process
        performRagSync(drive, ragFolders, apiKey, syncTarget);

        res.json({ success: true, message: `Sync started in background (target: ${syncTarget})`, target: syncTarget });

    } catch (error) {
        console.error("RAG Sync Trigger Error:", error);
        res.status(500).json({ error: 'Failed to start sync', details: error.message });
    }
});

// RAG: Get Sync Status
app.get('/api/rag/status', requireAuth, (req, res) => {
    res.json(ragSyncStatus);
});

// RAG: Get Popular FAQ Queries
app.get('/api/rag/popular-queries', requireAuth, (req, res) => {
    db.all(
        "SELECT query_text, usage_count FROM rag_queries ORDER BY usage_count DESC, last_used_at DESC LIMIT 5",
        [],
        (err, rows) => {
            if (err) {
                console.error("Failed to fetch popular queries:", err);
                return res.status(500).json({ error: "Failed to fetch popular queries" });
            }
            res.json(rows || []);
        }
    );
});

// RAG: Manage FAQ Queries (Get All)
app.get('/api/rag/popular-queries/all', requirePermission('action:manage_system_settings'), (req, res) => {
    db.all(
        "SELECT id, query_text, usage_count, last_used_at FROM rag_queries ORDER BY usage_count DESC, last_used_at DESC",
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// RAG: Add FAQ Query
app.post('/api/rag/popular-queries', requirePermission('action:manage_system_settings'), (req, res) => {
    const { query_text, usage_count } = req.body;
    if (!query_text || !query_text.trim()) {
        return res.status(400).json({ error: "Query text is required" });
    }
    const count = Number(usage_count) > 0 ? Number(usage_count) : 10;
    db.run(
        `INSERT INTO rag_queries (query_text, usage_count, last_used_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(query_text) DO UPDATE SET usage_count = excluded.usage_count, last_used_at = CURRENT_TIMESTAMP`,
        [query_text.trim(), count],
        function (err) {
            if (err) {
                console.error("Failed to insert FAQ query:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this?.lastID });
        }
    );
});

// RAG: Update FAQ Query
app.put('/api/rag/popular-queries/:id', requirePermission('action:manage_system_settings'), (req, res) => {
    const { id } = req.params;
    const { query_text, usage_count } = req.body;
    if (usage_count !== undefined) {
        db.run("UPDATE rag_queries SET query_text = ?, usage_count = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [query_text, Number(usage_count) || 1, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    } else {
        db.run("UPDATE rag_queries SET query_text = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [query_text, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    }
});

// RAG: Delete FAQ Query
app.delete('/api/rag/popular-queries/:id', requirePermission('action:manage_system_settings'), (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM rag_queries WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Chat: Get Preset Prompts (Personal with fallback to system default)
app.get('/api/chat/presets', requireAuth, async (req, res) => {
    try {
        db.get("SELECT chat_presets FROM user_preferences WHERE user_id = ?", [req.user.id], async (err, row) => {
            if (!err && row && row.chat_presets) {
                try {
                    return res.json(JSON.parse(row.chat_presets));
                } catch (e) {}
            }
            // Fall back to system-wide default presets
            try {
                const presets = await db.getSetting('CHAT_PRESET_PROMPTS') || '{}';
                res.json(JSON.parse(presets));
            } catch (e) {
                res.json({});
            }
        });
    } catch (e) {
        res.json({});
    }
});

// Chat: Save Preset Prompts (Personal for all authenticated users, System if admin explicitly requests)
app.post('/api/chat/presets', requireAuth, async (req, res) => {
    try {
        const presetsJson = JSON.stringify(req.body);
        
        // If admin requests saving system presets
        const isAdmin = req.user.role === 'admin' || (req.user.allowed_actions && req.user.allowed_actions.includes('action:manage_system_settings'));
        if (req.body.is_system && isAdmin) {
            await db.setSetting('CHAT_PRESET_PROMPTS', presetsJson);
            return res.json({ success: true, scope: 'system' });
        }

        // Save to user_preferences for the current user
        db.run(
            `INSERT INTO user_preferences (user_id, chat_presets, updated_at) 
             VALUES (?, ?, CURRENT_TIMESTAMP) 
             ON CONFLICT(user_id) DO UPDATE SET chat_presets = excluded.chat_presets, updated_at = CURRENT_TIMESTAMP`,
            [req.user.id, presetsJson],
            (err) => {
                if (err) {
                    console.error("Failed to save user chat presets:", err);
                    return res.status(500).json({ error: 'Failed to save presets' });
                }
                res.json({ success: true, scope: 'user' });
            }
        );
    } catch (e) {
        console.error("Error in POST /api/chat/presets:", e);
        res.status(500).json({ error: 'Failed to save presets' });
    }
});

// RAG: Check if Sync is Needed
app.get('/api/rag/check-sync-needed', requireAuth, async (req, res) => {
    try {
        let ragFolders = [];
        try {
            ragFolders = JSON.parse(await db.getSetting('GOOGLE_DRIVE_RAG_FOLDERS') || '[]');
        } catch (e) {
            ragFolders = [];
        }
        
        if (ragFolders.length === 0) {
            return res.json({ syncNeeded: false, reason: 'unconfigured' });
        }

        const drive = await getDriveClient(req, res);
        if (!drive) return; // Response is handled by helper

        // List files in drive
        let allDriveFiles = [];
        for (const folder of ragFolders) {
            const files = await listFolderFilesRecursively(drive, folder.id, folder.name);
            allDriveFiles = allDriveFiles.concat(files);
        }

        // Deduplicate drive files just in case
        const driveFilesMap = new Map();
        allDriveFiles.forEach(f => driveFilesMap.set(f.id, f));
        const driveFiles = Array.from(driveFilesMap.values());
        
        // Fetch DB files
        const dbFiles = await new Promise((resolve, reject) => {
            db.all("SELECT drive_file_id, last_synced_at FROM rag_files", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const dbFileMap = new Map(dbFiles.map(f => {
            let syncTimeStr = f.last_synced_at;
            if (syncTimeStr && !syncTimeStr.endsWith('Z') && !syncTimeStr.includes('T')) {
                syncTimeStr = syncTimeStr.replace(' ', 'T') + 'Z';
            }
            return [f.drive_file_id, new Date(syncTimeStr).getTime()];
        }));

        // 1. Check for Deleted Files (DB has IDs not in Drive)
        const driveIds = new Set(driveFiles.map(f => f.id));
        const hasDeletedFiles = dbFiles.some(f => !driveIds.has(f.drive_file_id));
        if (hasDeletedFiles) {
            console.log("Sync check: obsolete files found in DB that are no longer in Drive.");
            return res.json({ syncNeeded: true, reason: 'deleted_files' });
        }

        const lastSyncTimeStr = await db.getSetting('LAST_RAG_SYNC_TIME');
        const lastSyncTimeMs = lastSyncTimeStr ? new Date(lastSyncTimeStr).getTime() : 0;

        // 2. Check for New or Updated Files
        for (const file of driveFiles) {
            if (!dbFileMap.has(file.id)) {
                // If it's a new file, but its modifiedTime is BEFORE our last successful sync,
                // it means this file failed to sync (e.g. 404/403 errors, shared drive permission)
                // during the last run. We skip warning about it because syncing it again will just fail.
                const driveTime = new Date(file.modifiedTime).getTime();
                if (driveTime > lastSyncTimeMs) {
                    console.log(`Sync check: actual new file found: ${file.id}`);
                    return res.json({ syncNeeded: true, reason: 'new_files' });
                }
                continue;
            }
            const driveTime = new Date(file.modifiedTime).getTime();
            // Allow 5 minutes of buffer for upload/parse times
            if (driveTime > dbFileMap.get(file.id) + 300000) {
                console.log(`Sync check: updated file found: ${file.id}`);
                return res.json({ syncNeeded: true, reason: 'updated_files' });
            }
        }

        res.json({ syncNeeded: false, reason: 'synced' });

    } catch (error) {
        console.error("Sync Check Error:", error);
        res.status(500).json({ syncNeeded: false, error: 'Failed to verify sync' });
    }
});



// Google Drive: Upload/Update file
app.post('/api/drive/upload', requireAuth, requireWidgetAccess('app:finder'), async (req, res) => {
    try {
        const { name, content, mimeType, folderId, fileId, isDoc } = req.body;
        console.log('Upload Request Body Summary:', JSON.stringify({ name, mimeType, folderId, fileId, isDoc }, null, 2));
        console.log('Upload Request Content Type & Length:', {
            type: typeof content,
            length: typeof content === 'string' ? content.length : (Buffer.isBuffer(content) ? content.length : 'unknown'),
            byteLength: typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : 'unknown'
        });

        if (!content) return res.status(400).json({ error: 'Content is required' });

        const drive = await getDriveClient(req, res);
        if (!drive) return;

        // Resolve folder ID - use configured root if 'root' or not provided
        let resolvedFolderId = folderId;
        if (!folderId || folderId === 'root') {
            const configuredRoot = await db.getSetting('GOOGLE_DRIVE_ROOT_ID');
            resolvedFolderId = configuredRoot || null;
        }

        // Create a Readable stream from the content string or buffer
        const { Readable } = require('stream');

        // Helper to create fresh media object with new stream for each attempt
        const createMedia = () => {
            let bodyStream;
            
            // Check if the content is base64 (like from image generation)
            if (mimeType && mimeType.startsWith('image/') && typeof content === 'string' && !content.startsWith('http')) {
                // Remove the data:image/png;base64, prefix if present
                const base64Data = content.replace(/^data:image\/\w+;base64,/, '');
                bodyStream = Readable.from(Buffer.from(base64Data, 'base64'));
            } else if (typeof content === 'string') {
                // Pass Buffer inside a Readable stream to ensure correct Content-Length (bytes, not characters)
                // and to avoid Transfer-Encoding: chunked issues or "pipe is not a function" errors.
                bodyStream = Readable.from(Buffer.from(content, 'utf-8'));
            } else {
                bodyStream = content;
            }

            return {
                mimeType: mimeType || 'text/plain',
                body: bodyStream
            };
        };

        let response;

        // Helper to safely create file, falling back to root if folder not found
        const safeCreate = async (metadata) => {
            if (isDoc) {
                 metadata.mimeType = 'application/vnd.google-apps.document';
            }
            try {
                return await drive.files.create({
                    resource: metadata,
                    media: createMedia(),
                    fields: 'id, name, webViewLink, webContentLink',
                    supportsAllDrives: true
                });
            } catch (createError) {
                // Check for 404 (Parent not found)
                const isNotFound =
                    createError.code === 404 ||
                    createError.code === '404' ||
                    createError.status === 404 ||
                    createError.status === '404' ||
                    (createError.errors && createError.errors[0]?.reason === 'notFound');

                if (isNotFound && metadata.parents && metadata.parents.length > 0) {
                    console.log(`Folder ${metadata.parents[0]} not found. Falling back to root...`);
                    const rootMetadata = { ...metadata };
                    delete rootMetadata.parents; // Remove parents to save in Root
                    return await drive.files.create({
                        resource: rootMetadata,
                        media: createMedia(), // Create NEW stream for retry
                        fields: 'id, name, webViewLink, webContentLink',
                        supportsAllDrives: true
                    });
                }
                throw createError;
            }
        };

        if (fileId) {
            try {
                // Update existing file
                console.log(`Updating file ${fileId}...`);
                
                const updateMetadata = {};
                if (isDoc) {
                    updateMetadata.mimeType = 'application/vnd.google-apps.document';
                }
                
                response = await drive.files.update({
                    fileId: fileId,
                    resource: updateMetadata,
                    media: createMedia(),
                    fields: 'id, name, webViewLink, webContentLink',
                    supportsAllDrives: true
                });
            } catch (updateError) {
                console.log("Update detected error:", updateError.code, updateError.message);

                // Check for 404 Not Found
                const isNotFound =
                    updateError.code === 404 ||
                    updateError.code === '404' ||
                    updateError.status === 404 ||
                    updateError.status === '404' ||
                    (updateError.errors && updateError.errors[0]?.reason === 'notFound');

                // If file not found (404), fall back to create new file
                if (isNotFound) {
                    console.log(`File ${fileId} not found (404). Creating new file instead...`);
                    // Fall through to create logic
                    const fileMetadata = {
                        name: name || 'Untitled',
                    };
                    // Only add parents if we have a valid folder ID
                    if (resolvedFolderId) {
                        fileMetadata.parents = [resolvedFolderId];
                    }
                    response = await safeCreate(fileMetadata);
                } else {
                    // Re-throw other errors
                    throw updateError;
                }
            }
        } else {
            // Create new file
            const fileMetadata = {
                name: name || 'Untitled',
            };

            // Only add parents if we have a valid folder ID
            if (resolvedFolderId) {
                fileMetadata.parents = [resolvedFolderId];
            }

            response = await safeCreate(fileMetadata);
        }

        res.json(response.data);

    } catch (error) {
        const util = require('util');
        console.error("Drive Upload Error:", error.message);
        console.error("Error Stack:", error.stack);
        if (error.response) {
            console.error("Error Response Data Dump:", util.inspect(error.response.data, { depth: null }));
            console.log("Error Response Status:", error.response.status);
            console.log("Error Response Headers:", util.inspect(error.response.headers, { depth: null }));
        }
        if (error.errors) {
            console.error("Error Details Array Dump:", util.inspect(error.errors, { depth: null }));
        }
        if (error.config) {
            console.log("Request Config Dump:", util.inspect(error.config, { depth: 3 }));
        }
        res.status(500).json({
            error: 'Failed to upload file',
            details: error.message,
            errorData: error.response?.data || error.errors || null
        });
    }
});

// File System: List directory content
app.get('/api/fs/list', requireAuth, (req, res, next) => {
    const allowedWidgets = req.user.allowed_widgets || [];
    const hasAccess = allowedWidgets.includes('*') || allowedWidgets.includes('app:browser') || allowedWidgets.includes('app:finder');
    if (!hasAccess) {
        auditDb.logEvent({
            userId: req.user.id,
            userEmail: req.user.email,
            eventType: 'permission_denied',
            action: 'GET /api/fs/list',
            status: 'blocked',
            req: req,
            details: { error: 'FS list access denied', details: 'Requires app:browser or app:finder widget access' }
        });
        return res.status(403).json({ error: 'Access denied. Requires app:browser or app:finder access.' });
    }
    next();
}, async (req, res) => {
    const { path: dirPath } = req.query;
    // Default to user's home directory if no path provided
    const targetPath = dirPath || require('os').homedir();

    try {
        const fs = require('fs').promises;
        const path = require('path');

        const entries = await fs.readdir(targetPath, { withFileTypes: true });

        const files = entries.map(entry => {
            const fullPath = path.join(targetPath, entry.name);
            const isDirectory = entry.isDirectory();
            // Simple mimeType estimation
            let mimeType = isDirectory ? 'application/vnd.google-apps.folder' : 'application/octet-stream';
            if (!isDirectory) {
                if (entry.name.endsWith('.html')) mimeType = 'text/html';
                else if (entry.name.endsWith('.png')) mimeType = 'image/png';
                else if (entry.name.endsWith('.jpg')) mimeType = 'image/jpeg';
                else if (entry.name.endsWith('.txt')) mimeType = 'text/plain';
                else if (entry.name.endsWith('.pdf')) mimeType = 'application/pdf';
            }

            return {
                id: fullPath, // Use full path as ID for local files
                name: entry.name,
                mimeType: mimeType,
                iconLink: null, // Frontend will handle default icons
                thumbnailLink: null
            };
        });

        res.json({ files });
    } catch (error) {
        console.error("File List Error:", error);
        res.status(500).json({ error: 'Failed to list directory' });
    }
});

// Google Drive API endpoints
// Google Drive API endpoints

// Helper to get Drive Client
async function getDriveClient(req, res) {
    const token = req.cookies.token;
    if (!token) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }

    return new Promise((resolve) => {
        jwt.verify(token, process.env.JWT_SECRET || 'secret', async (err, decoded) => {
            if (err) {
                res.status(403).json({ error: 'Invalid token' });
                resolve(null);
                return;
            }

            // Get user tokens from DB
            db.get("SELECT access_token, refresh_token, token_expiry FROM users WHERE google_id = ?", [decoded.googleId], async (err, row) => {
                if (err) {
                    console.error("DB Error in getDriveClient:", err);
                    res.status(500).json({ error: 'Database error' });
                    resolve(null);
                    return;
                }
                if (!row || !row.access_token) {
                    console.error("No access token found for user:", decoded.googleId);
                    res.status(403).json({ error: 'No Google Drive access token found.', code: 'GOOGLE_TOKEN_MISSING' });
                    resolve(null);
                    return;
                }

                console.log(`Drive Client: Using token for user ${decoded.googleId}. Has Refresh Token: ${!!row.refresh_token}. Expiry: ${row.token_expiry}`);

                const oAuth2Client = await getOAuthClient();
                oAuth2Client.setCredentials({
                    access_token: decrypt(row.access_token),
                    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : undefined,
                    // If token_expiry is missing in DB (old records), send 1 to force immediate refresh
                    expiry_date: row.token_expiry || 1 
                });

                // Listen for new tokens and update DB
                oAuth2Client.on('tokens', (tokens) => {
                    console.log("OAuth Client: Received new tokens");
                    if (tokens.access_token) {
                        const updateSql = `UPDATE users SET access_token = ?, token_expiry = ?` + (tokens.refresh_token ? `, refresh_token = ?` : ``) + ` WHERE google_id = ?`;
                        const params = [encrypt(tokens.access_token), tokens.expiry_date || null];
                        if (tokens.refresh_token) params.push(encrypt(tokens.refresh_token));
                        params.push(decoded.googleId);

                        db.run(updateSql, params, (err) => {
                            if (err) console.error("Failed to update refreshed tokens in DB:", err);
                            else console.log("Updated refreshed tokens in DB");
                        });
                    }
                });

                // Force token refresh check
                try {
                    // This will actively fetch a new token if expiry_date is null/past due
                    await oAuth2Client.getAccessToken();
                } catch (tokenErr) {
                    console.error("Failed to refresh access token:", tokenErr);
                    // If refresh fails (e.g. revoked), we might want to fail here
                    // But let's try to proceed or return null
                }

                console.log("Drive Client: Resolving with client");
                resolve(google.drive({ version: 'v3', auth: oAuth2Client }));
            });
        });
    });
}
app.get('/api/drive/folder_info', requireAuth, requireWidgetAccess('app:finder'), async (req, res) => {
    try {
        const folderId = req.query.folderId;
        if (!folderId) return res.status(400).json({ error: 'Missing folderId' });

        const drive = await getDriveClient(req, res);
        if (!drive) return; // Response already sent

        // Extract ID if it's a URL
        let finalFolderId = folderId;
        if (finalFolderId.includes('drive.google.com')) {
            const match = finalFolderId.match(/[-\w]{25,}/);
            if (match) {
                finalFolderId = match[0];
            }
        }

        const fileMeta = await drive.files.get({
            fileId: finalFolderId,
            fields: 'id, name, webViewLink',
            supportsAllDrives: true
        });

        res.json(fileMeta.data);
    } catch (error) {
        console.error('Drive Folder Info Error:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch folder info' });
    }
});
app.get('/api/drive/list', requireAuth, requireWidgetAccess('app:finder'), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const drive = await getDriveClient(req, res);
        if (!drive) return; // Response already sent

        let folderId = req.query.folderId;

        // If folderId is 'root' or not provided, check for configured root ID
        if (!folderId || folderId === 'root') {
            const configuredRoot = await db.getSetting('GOOGLE_DRIVE_ROOT_ID');
            folderId = configuredRoot || 'root';
        }

        // Extract ID if it's a URL
        if (folderId && folderId.includes('drive.google.com')) {
            const match = folderId.match(/[-\w]{25,}/);
            if (match) {
                folderId = match[0];
            }
        }

        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, iconLink, webViewLink, thumbnailLink)',
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        res.json({ files: response.data.files });
    } catch (error) {
        console.error("Drive List Fatal Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
    }
});

app.get('/api/drive/read', requireAuth, requireWidgetAccess('app:finder'), async (req, res) => {
    const drive = await getDriveClient(req, res);
    if (!drive) return;

    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).json({ error: 'File ID required' });

    try {
        // Check mimeType first
        const fileMeta = await drive.files.get({
            fileId,
            fields: 'mimeType, name, webViewLink',
            supportsAllDrives: true
        });
        const mimeType = fileMeta.data.mimeType;

        if (mimeType === 'application/vnd.google-apps.document') {
            // Export Google Docs to HTML
            const response = await drive.files.export({
                fileId,
                mimeType: 'text/html',
            });
            res.json({ content: response.data, type: 'html', name: fileMeta.data.name });
        } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
            // Export Sheets to PDF (or CSV) - let's do PDF for now or CSV? Browser can't read CSV easily without parsing.
            // Let's try HTML? Sheets export to HTML is zip.
            // For now, let's just return metadata for non-text files.
            res.json({ content: null, type: 'binary', name: fileMeta.data.name, webViewLink: fileMeta.data.webViewLink });
        } else {
            // Try to read as text/binary
            const response = await drive.files.get({
                fileId,
                alt: 'media',
            }, { responseType: 'text' }); // Assume text for now
            res.json({ content: response.data, type: 'text', name: fileMeta.data.name });
        }
    } catch (error) {
        console.error("Drive Read Error:", error);
    }
});

// Calendar API endpoints
async function getCalendarClient(req, res, targetEmail = null) {
    const token = req.cookies.token;
    if (!token) {
        if (res) res.status(401).json({ error: 'Not authenticated' });
        return null;
    }

    return new Promise((resolve) => {
        jwt.verify(token, process.env.JWT_SECRET || 'secret', async (err, decoded) => {
            if (err) {
                if (res) res.status(403).json({ error: 'Invalid token' });
                resolve(null);
                return;
            }

            const query = targetEmail 
                ? "SELECT access_token, refresh_token, google_id FROM users WHERE email = ?" 
                : "SELECT access_token, refresh_token, google_id FROM users WHERE google_id = ?";
            const param = targetEmail ? targetEmail : decoded.googleId;

            db.get(query, [param], async (err, row) => {
                if (err || !row || !row.access_token) {
                    if (res) res.status(403).json({ error: 'No Google Calendar access token found', code: 'GOOGLE_TOKEN_MISSING' });
                    resolve(null);
                    return;
                }

                const oAuth2Client = await getOAuthClient();
                oAuth2Client.setCredentials({
                    access_token: decrypt(row.access_token),
                    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : undefined
                });

                oAuth2Client.on('tokens', (tokens) => {
                    if (tokens.access_token) {
                        const updateSql = `UPDATE users SET access_token = ?` + (tokens.refresh_token ? `, refresh_token = ?` : ``) + ` WHERE google_id = ?`;
                        const params = [encrypt(tokens.access_token)];
                        if (tokens.refresh_token) params.push(encrypt(tokens.refresh_token));
                        params.push(row.google_id);
                        db.run(updateSql, params, (err) => {
                            if (err) console.error("Failed to update tokens during API call:", err);
                        });
                    }
                });

                resolve(google.calendar({ version: 'v3', auth: oAuth2Client }));
            });
        });
    });
}

app.get('/api/calendar/events', requireAuth, requireWidgetAccess('app:calendar'), async (req, res) => {
    try {
        const { timeMin, timeMax, email } = req.query;
        const calendar = await getCalendarClient(req, res, email);
        if (!calendar) return;

        // 1. Fetch events from primary calendar only
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMin || (new Date(new Date().getFullYear(), new Date().getMonth(), 1)).toISOString(),
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        let allEvents = (response.data.items || []).map(item => ({
            ...item,
            calendarId: 'primary',
            calendarSummary: 'Primary'
        }));

        // 2. Filter out non-default events (workingLocation, outOfOffice, etc.)
        allEvents = allEvents.filter(event => {
            // eventType is 'default' for regular meetings. 
            // 'workingLocation' is used for things like "自宅".
            return !event.eventType || event.eventType === 'default';
        });

        // Sort by start time
        allEvents.sort((a, b) => {
            const startA = new Date(a.start.dateTime || a.start.date);
            const startB = new Date(b.start.dateTime || b.start.date);
            return startA - startB;
        });

        res.json({ events: allEvents });
    } catch (error) {
        console.error("Calendar List Error:", error);
        res.status(500).json({ error: 'Failed to list events', details: error.message });
    }
});

app.post('/api/calendar/events', requireAuth, requireWidgetAccess('app:calendar'), async (req, res) => {
    try {
        const calendar = await getCalendarClient(req, res);
        if (!calendar) return;

        const { summary, description, start, end } = req.body;
        const event = {
            summary,
            description,
            start: { dateTime: start },
            end: { dateTime: end },
        };

        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });
        res.json({ event: response.data });
    } catch (error) {
        console.error("Calendar Create Error:", error);
        res.status(500).json({ error: 'Failed to create event', details: error.message });
    }
});

// Helper: 従来のプログラム計算ロジック（フォールバック用）
function getCommonFreeSlotsProgrammatic(now, y, m, d, mergedBusy, settings) {
    const assistantWorkStart = settings.workStart || '09:00';
    const assistantWorkEnd = settings.workEnd || '17:30';
    const assistantMeetingBuffer = settings.meetingBuffer !== undefined ? settings.meetingBuffer : 30;

    const startBufferMs = 30 * 60 * 1000;
    const workStart = new Date(`${y}-${m}-${d}T${assistantWorkStart}:00+09:00`);
    const startSearch = now.getTime() + startBufferMs > workStart.getTime()
        ? new Date(now.getTime() + startBufferMs)
        : workStart;

    const workEnd = new Date(`${y}-${m}-${d}T${assistantWorkEnd}:00+09:00`);
    
    // 1. 通常枠のデッドライン (終業のバッファ分前)
    const endSearchNormal = new Date(workEnd.getTime() - assistantMeetingBuffer * 60 * 1000);
    // 2. 就業時間内ギリギリのデッドライン (終業時間そのもの。ミーティングが就業時間内に収まる限界)
    const endSearchInWork = workEnd;
    // 3. 時間外のデッドライン (終業1時間後。時間外ミーティングが終了する限界)
    const endSearchOvertime = new Date(workEnd.getTime() + 60 * 60 * 1000);

    const calculateSlotsForRange = (rangeStart, rangeEnd) => {
        if (rangeStart >= rangeEnd) return [];
        const slots = [];
        let currentPointer = rangeStart;
        const minDuration = 30 * 60 * 1000;

        for (const busy of mergedBusy) {
            if (busy.end <= currentPointer) continue;
            if (busy.start >= rangeEnd) break;
            const duration = busy.start - currentPointer;
            if (duration >= minDuration) {
                slots.push({ start: new Date(currentPointer), end: new Date(busy.start) });
            }
            currentPointer = new Date(Math.max(currentPointer, busy.end));
        }

        if (rangeEnd - currentPointer >= minDuration) {
            slots.push({ start: new Date(currentPointer), end: new Date(rangeEnd) });
        }
        return slots;
    };

    // 1段階：通常枠の探索
    const normalSlots = calculateSlotsForRange(startSearch, endSearchNormal);
    if (normalSlots.length > 0) {
        return { slots: normalSlots, isOvertime: false, isBufferMitigated: false };
    }

    // 2段階：通常枠になければ、就業時間内のバッファ緩和枠を探索
    if (startSearch < endSearchInWork) {
        const mitigationStart = startSearch > endSearchNormal ? startSearch : endSearchNormal;
        const mitigatedSlots = calculateSlotsForRange(mitigationStart, endSearchInWork);
        if (mitigatedSlots.length > 0) {
            return { slots: mitigatedSlots, isOvertime: false, isBufferMitigated: true };
        }
    }

    // 3段階：就業時間内にもなければ、時間外枠を探索
    if (startSearch < endSearchOvertime) {
        const overtimeStart = startSearch > endSearchInWork ? startSearch : endSearchInWork;
        const overtimeSlots = calculateSlotsForRange(overtimeStart, endSearchOvertime);
        if (overtimeSlots.length > 0) {
            return { slots: overtimeSlots, isOvertime: true, isBufferMitigated: false };
        }
    }

    return { slots: [], isOvertime: false, isBufferMitigated: false };
}

// カレンダーの予定一覧から移動が必要な予定を検出し、移動時間を推測する
async function estimateTravelTimes(apiKey, events, ownerName, claudeApiKey = null, aiProvider = 'gemini') {
    if (!events || events.length === 0) return [];
    
    try {
        const formatEventsForTravel = (events) => {
            return events.map(e => {
                const start = e.start.dateTime || e.start.date;
                const end = e.end.dateTime || e.end.date;
                return {
                    id: e.id,
                    summary: e.summary,
                    location: e.location || '',
                    start,
                    end
                };
            });
        };

        const eventsText = JSON.stringify(formatEventsForTravel(events), null, 2);

        const prompt = `あなたはカレンダーの予定から移動時間を正確に予測するAIアシスタントです。
提供された ${ownerName} のカレンダー予定リストから、「外出」「訪問」「アポイント」「客先」などの移動が発生する予定（または場所がオフィス外と推測される予定）を特定し、それぞれの予定に必要な「往路移動時間（分）」と「復路移動時間（分）」を予測してください。

【予測のルール】
1. BOSS（ユーザー）のオフィスまたは拠点は「品川」と想定してください。
2. 予定のタイトルや場所（location）に含まれる地名（例：八王子、新宿、横浜、渋谷など）を元に、拠点（品川）からの電車の現実的な所要時間を推測してください。
   （例：新宿 ➔ 片道30分、八王子 ➔ 片道75分、横浜 ➔ 片道45分、渋谷 ➔ 片道20分、など。駅名や地名に応じた実際の電車所要時間をベースにしてください）
3. 場所や目的地が不明だがタイトル等から「外出」であることが明らかな予定の場合は、デフォルトとして一律「前後30分」の移動時間を適用してください。
4. 社内会議やオンライン会議（例：「Teams」「Zoom」「オンライン」「Web面談」などの記述がある予定）や、明らかに移動が発生しない予定（例：「デスクワーク」「開発」「社内」など）については、移動時間を 0 分としてください。

以下のJSONフォーマット（配列）のみで出力してください。思考プロセスやマークダウンブロックの \`\`\`json などの囲み、説明文などは一切出力せず、純粋なJSON文字列のみを返してください。
[
  {
    "id": "予定のID",
    "summary": "予定のタイトル",
    "outboundMinutes": 往路移動時間（数値・分）,
    "inboundMinutes": 復路移動時間（数値・分）,
    "reason": "移動時間を推測した理由（例: 品川から新宿まで山手線で約20分＋徒歩10分を考慮）"
  }
]
もし移動が発生する予定がない場合は、空の配列 [] を返してください。

【予定リスト】
${eventsText}`;

        let textResponse = '';
        if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
            const claudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
            textResponse = (await llmAdapter.generateTextWithClaude({
                apiKey: claudeApiKey,
                model: claudeModel,
                prompt,
                temperature: 0.2,
                jsonMode: true
            })).trim();
        } else {
            const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
            const modelName = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
            const aiResponse = await client.models.generateContent({
                model: modelName,
                contents: prompt
            });
            textResponse = (aiResponse.text || '').trim();
        }

        console.log(`AI Travel Time Estimation Output (${ownerName}):`, textResponse);

        const cleanJson = textResponse.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        const travelEstimations = JSON.parse(cleanJson);
        
        if (Array.isArray(travelEstimations)) {
            return travelEstimations;
        }
        return [];
    } catch (err) {
        console.error(`Failed to estimate travel times for ${ownerName}:`, err);
        return [];
    }
}

// Helper: 本日の双方の共通空きスロット（30分以上）を計算（Gemini / Claude 推論併用）
async function getCommonFreeSlots(req, res, targetEmail, settings = {}) {
    const calendarSelf = await getCalendarClient(req, res, null); // ログインユーザー
    const calendarTarget = await getCalendarClient(req, res, targetEmail); // 相手

    if (!calendarSelf || !calendarTarget) {
        throw new Error("Could not initialize calendar clients");
    }

    const now = new Date();
    // JSTタイムゾーンでの「本日」を取得
    const formatter = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;

    const timeMin = `${y}-${m}-${d}T00:00:00+09:00`;
    const timeMax = `${y}-${m}-${d}T23:59:59+09:00`;

    // 双方のカレンダーからイベント取得
    const [resSelf, resTarget] = await Promise.all([
        calendarSelf.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true }),
        calendarTarget.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true })
    ]);

    const eventsSelf = resSelf.data.items || [];
    const eventsTarget = resTarget.data.items || [];

    // イベントフィルタリング (defaultのみ)
    const filterDefault = (events) => events.filter(e => !e.eventType || e.eventType === 'default');
    const filteredSelf = filterDefault(eventsSelf);
    const filteredTarget = filterDefault(eventsTarget);

    // Gemini / Claude APIキーの有無をチェック
    const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');
    
    // APIキーがない場合は従来のロジックで移動時間を0としてフォールバック
    if (!apiKey && !claudeApiKey) {
        console.log("AI API Key not set. Falling back to programmatic free slots calculator (no travel time).");
        const busySlots = [];
        [...filteredSelf, ...filteredTarget].forEach(event => {
            const start = new Date(event.start.dateTime || event.start.date);
            const end = new Date(event.end.dateTime || event.end.date);
            busySlots.push({ start, end });
        });
        busySlots.sort((a, b) => a.start - b.start);
        const mergedBusy = [];
        if (busySlots.length > 0) {
            let current = busySlots[0];
            for (let i = 1; i < busySlots.length; i++) {
                const next = busySlots[i];
                if (next.start <= current.end) {
                    current.end = new Date(Math.max(current.end, next.end));
                } else {
                    mergedBusy.push(current);
                    current = next;
                }
            }
            mergedBusy.push(current);
        }
        const result = getCommonFreeSlotsProgrammatic(now, y, m, d, mergedBusy, settings);
        return { slots: result.slots, isOvertime: result.isOvertime, isBufferMitigated: result.isBufferMitigated, travelDetails: [] };
    }

    try {
        console.log(`Estimating travel times using ${aiProvider}...`);
        const [travelSelf, travelTarget] = await Promise.all([
            estimateTravelTimes(apiKey, filteredSelf, 'BOSS', claudeApiKey, aiProvider),
            estimateTravelTimes(apiKey, filteredTarget, '対話相手', claudeApiKey, aiProvider)
        ]);

        const busySlots = [];
        const travelDetails = [];

        // BOSSの予定処理（移動時間を考慮した仮想Busy枠の追加）
        filteredSelf.forEach(event => {
            const start = new Date(event.start.dateTime || event.start.date);
            const end = new Date(event.end.dateTime || event.end.date);
            busySlots.push({ start, end });

            const est = travelSelf.find(t => t.id === event.id);
            if (est) {
                if (est.outboundMinutes > 0) {
                    const vStart = new Date(start.getTime() - est.outboundMinutes * 60 * 1000);
                    busySlots.push({ start: vStart, end: start });
                    travelDetails.push({
                        summary: event.summary,
                        type: '往路',
                        minutes: est.outboundMinutes,
                        reason: est.reason
                    });
                }
                if (est.inboundMinutes > 0) {
                    const vEnd = new Date(end.getTime() + est.inboundMinutes * 60 * 1000);
                    busySlots.push({ start: end, end: vEnd });
                    travelDetails.push({
                        summary: event.summary,
                        type: '復路',
                        minutes: est.inboundMinutes,
                        reason: est.reason
                    });
                }
            }
        });

        // 相手の予定処理（移動時間を考慮した仮想Busy枠の追加）
        filteredTarget.forEach(event => {
            const start = new Date(event.start.dateTime || event.start.date);
            const end = new Date(event.end.dateTime || event.end.date);
            busySlots.push({ start, end });

            const est = travelTarget.find(t => t.id === event.id);
            if (est) {
                if (est.outboundMinutes > 0) {
                    const vStart = new Date(start.getTime() - est.outboundMinutes * 60 * 1000);
                    busySlots.push({ start: vStart, end: start });
                    travelDetails.push({
                        summary: `(相手) ${event.summary}`,
                        type: '往路',
                        minutes: est.outboundMinutes,
                        reason: est.reason
                    });
                }
                if (est.inboundMinutes > 0) {
                    const vEnd = new Date(end.getTime() + est.inboundMinutes * 60 * 1000);
                    busySlots.push({ start: end, end: vEnd });
                    travelDetails.push({
                        summary: `(相手) ${event.summary}`,
                        type: '復路',
                        minutes: est.inboundMinutes,
                        reason: est.reason
                    });
                }
            }
        });

        busySlots.sort((a, b) => a.start - b.start);

        // 重なる予定枠を結合する
        const mergedBusy = [];
        if (busySlots.length > 0) {
            let current = busySlots[0];
            for (let i = 1; i < busySlots.length; i++) {
                const next = busySlots[i];
                if (next.start <= current.end) {
                    current.end = new Date(Math.max(current.end, next.end));
                } else {
                    mergedBusy.push(current);
                    current = next;
                }
            }
            mergedBusy.push(current);
        }

        const result = getCommonFreeSlotsProgrammatic(now, y, m, d, mergedBusy, settings);
        return {
            slots: result.slots,
            isOvertime: result.isOvertime,
            isBufferMitigated: result.isBufferMitigated,
            travelDetails: travelDetails
        };

    } catch (aiErr) {
        console.error("Travel estimation failed, falling back to no-travel calculation:", aiErr);
        const busySlots = [];
        [...filteredSelf, ...filteredTarget].forEach(event => {
            const start = new Date(event.start.dateTime || event.start.date);
            const end = new Date(event.end.dateTime || event.end.date);
            busySlots.push({ start, end });
        });
        busySlots.sort((a, b) => a.start - b.start);
        const mergedBusy = [];
        if (busySlots.length > 0) {
            let current = busySlots[0];
            for (let i = 1; i < busySlots.length; i++) {
                const next = busySlots[i];
                if (next.start <= current.end) {
                    current.end = new Date(Math.max(current.end, next.end));
                } else {
                    mergedBusy.push(current);
                    current = next;
                }
            }
            mergedBusy.push(current);
        }
        const result = getCommonFreeSlotsProgrammatic(now, y, m, d, mergedBusy, settings);
        return { slots: result.slots, isOvertime: result.isOvertime, isBufferMitigated: result.isBufferMitigated, travelDetails: [] };
    }
}

// DM API Endpoints
app.get('/api/dm/messages', requireAuth, (req, res) => {
    const loginUserId = req.user.id;
    const targetUserId = parseInt(req.query.targetUserId);

    if (!targetUserId) {
        return res.status(400).json({ error: 'targetUserId is required' });
    }

    const sql = `
        SELECT * FROM dm_messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC
    `;
    db.all(sql, [loginUserId, targetUserId, targetUserId, loginUserId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch DM messages' });
        }
        
        // 相手から自分宛ての未読メッセージを既読にする
        db.run(
            "UPDATE dm_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0",
            [targetUserId, loginUserId],
            (updateErr) => {
                if (updateErr) console.error("Failed to mark messages as read:", updateErr);
            }
        );

        res.json({ messages: rows });
    });
});

app.get('/api/dm/unread', requireAuth, (req, res) => {
    const loginUserId = req.user.id;
    const sql = `
        SELECT m.id, m.sender_id, m.text, m.created_at, u.name as sender_name, u.avatar_url as sender_avatar
        FROM dm_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.receiver_id = ? AND m.is_read = 0 AND m.sender_type = 'user'
        ORDER BY m.created_at DESC
    `;
    db.all(sql, [loginUserId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch unread messages' });
        }
        res.json({ unread: rows });
    });
});

app.post('/api/dm/messages', requireAuth, async (req, res) => {
    const loginUserId = req.user.id;
    const { receiverId, text } = req.body;

    if (!receiverId || !text) {
        return res.status(400).json({ error: 'receiverId and text are required' });
    }

    const MAX_ACTIVE_SESSIONS = 2;

    // 受信者の直近10分間のアクティブセッション数（今回送信した loginUserId 以外のユニークな会話相手の数）をカウント
    const sessionSql = `
        SELECT COUNT(DISTINCT partner_id) as active_count FROM (
            SELECT receiver_id as partner_id FROM dm_messages 
            WHERE sender_id = ? AND created_at >= datetime('now', '-10 minutes') AND sender_type = 'user'
            UNION
            SELECT sender_id as partner_id FROM dm_messages 
            WHERE receiver_id = ? AND created_at >= datetime('now', '-10 minutes') AND sender_type = 'user'
        )
        WHERE partner_id != ?
    `;

    db.get(sessionSql, [receiverId, receiverId, loginUserId], async (sessionErr, sessionRow) => {
        if (sessionErr) {
            console.error("Failed to check active sessions:", sessionErr);
        }

        const activeCount = sessionRow ? sessionRow.active_count : 0;
        const isSessionLimitExceeded = activeCount >= MAX_ACTIVE_SESSIONS;

        // セッション制限超過の場合は is_read=1 (既読) でメッセージを保存して、受信者側への通知を抑制する。
        // 超過していない場合は is_read=0 (未読) で保存。
        const initialIsRead = isSessionLimitExceeded ? 1 : 0;

        db.get("SELECT * FROM users WHERE id = ?", [receiverId], async (err, targetUser) => {
            if (err || !targetUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            const senderLang = req.user.native_language || 'ja';
            const targetLang = targetUser.native_language || 'ja';
            const isDifferentLang = senderLang !== targetLang;
            const targetLangName = targetLang === 'en' ? 'English' : targetLang === 'es' ? 'Spanish' : 'Japanese';
            const senderLangName = senderLang === 'en' ? 'English' : senderLang === 'es' ? 'Spanish' : 'Japanese';
            const senderLangFlag = senderLang === 'en' ? '🇺🇸' : senderLang === 'es' ? '🇪🇸' : '🇯🇵';
            const targetLangFlag = targetLang === 'en' ? '🇺🇸' : targetLang === 'es' ? '🇪🇸' : '🇯🇵';

            let textToSave = text;
            const localAiEnabled = (await db.getSetting('LOCAL_AI_ENABLED')) === 'true';

            // 1. 言語が異なる場合のみ、Gemma 4 (Local AI) による相手言語への自動翻訳を実行
            if (isDifferentLang && localAiEnabled) {
                try {
                    const rawHost = (await db.getSetting('LOCAL_AI_HOST')) || 'http://localhost:11434';
                    const host = resolveLocalAiHost(rawHost);
                    const model = (await db.getSetting('LOCAL_AI_MODEL')) || 'gemma4:26b-mlx';

                    const transRes = await fetch(`${host}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model,
                            prompt: `You are an expert translator. Translate the following ${senderLangName} message accurately and naturally into ${targetLangName}. Output ONLY the translated text without quotes or explanations:\n\n"${text}"`,
                            stream: false,
                            options: { temperature: 0.2 }
                        })
                    });

                    if (transRes.ok) {
                        const tData = await transRes.json();
                        const translated = (tData.response || '').trim().replace(/^["']|["']$/g, '');
                        if (translated) {
                            textToSave = `🌐 [Gemma 4 Translated (${senderLangFlag} ➔ ${targetLangFlag})]\n${translated}\n\n(${senderLangFlag} 原文: ${text})`;
                        }
                    } else {
                        console.error("Gemma 4 translation returned error status:", transRes.status, await transRes.text());
                    }
                } catch (tErr) {
                    console.error("Gemma 4 translation failed:", tErr.message);
                }
            }

            // 2. メッセージをDBへ保存
            db.run(
                "INSERT INTO dm_messages (sender_id, receiver_id, sender_type, text, is_read) VALUES (?, ?, 'user', ?, ?)",
                [loginUserId, receiverId, textToSave, initialIsRead],
                async function(insertErr) {
                    if (insertErr) {
                        return res.status(500).json({ error: 'Failed to send message' });
                    }

                    const insertedId = this.lastID;

                    // セッション制限超過時の処理
                    if (isSessionLimitExceeded) {
                        const targetName = targetUser ? targetUser.name : '相手';
                        const replyText = `ただいま、${targetName} は複数のチャットが立ち上がっているため、対応できません。しばらく経ってから試してください。`;
                        
                        setTimeout(() => {
                            db.run(
                                "INSERT INTO dm_messages (sender_id, receiver_id, sender_type, text, is_read) VALUES (?, ?, 'assistant', ?, 1)",
                                [receiverId, loginUserId, replyText],
                                (replyErr) => {
                                    if (replyErr) console.error("Failed to insert session limit decline reply:", replyErr);
                                }
                            );
                        }, 1000);

                        return res.json({ status: 'ok', messageId: insertedId });
                    }

                    // 3. 通常のステータスに応じた自動返信処理
                    let replyText = '';
                    let isAssistant = false;
                    const isTargetOffline = isUserOffline(targetUser, loginUserId);

                    // 3-1. カレンダー空きスケジュールと移動時間の算出
                    let freeSlotsText = "なし";
                    let isOvertime = false;
                    let isBufferMitigated = false;
                    let travelDetailsText = "";

                    try {
                        const settings = {
                            workStart: targetUser.assistant_work_start,
                            workEnd: targetUser.assistant_work_end,
                            meetingBuffer: targetUser.assistant_meeting_buffer
                        };
                        const result = await getCommonFreeSlots(req, null, targetUser.email, settings);
                        const freeSlots = result.slots;
                        isOvertime = result.isOvertime;
                        isBufferMitigated = result.isBufferMitigated;
                        
                        if (freeSlots && freeSlots.length > 0) {
                            freeSlotsText = freeSlots.slice(0, 3).map(slot => {
                                const options = { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false };
                                const startStr = slot.start.toLocaleTimeString('ja-JP', options);
                                const endStr = slot.end.toLocaleTimeString('ja-JP', options);
                                return `・ ${startStr} 〜 ${endStr}`;
                            }).join('\n');
                            
                            if (result.travelDetails && result.travelDetails.length > 0) {
                                travelDetailsText = result.travelDetails.map(t => {
                                    return `・ ${t.summary} (${t.type}): ${t.minutes}分を追加 (${t.reason})`;
                                }).join('\n');
                            }
                        }
                    } catch (slotErr) {
                        console.error("Failed to fetch slots for AI Assistant context:", slotErr);
                    }

                    // 3-2. Local AI (Gemma 4) による自動応答（相手の言語で生成）
                    if (localAiEnabled) {
                        try {
                            const rawHost = (await db.getSetting('LOCAL_AI_HOST')) || 'http://localhost:11434';
                            const host = resolveLocalAiHost(rawHost);
                            const model = (await db.getSetting('LOCAL_AI_MODEL')) || 'gemma4:26b-mlx';

                            const defaultPrompt = await db.getSetting('DEFAULT_ASSISTANT_PROMPT') || '';
                            const basePrompt = targetUser.assistant_prompt || defaultPrompt;

                            const systemInstruction = `You are an executive AI Assistant for ${targetUser.name} (${targetUser.role || 'Boss'}).
- Current Room: ${targetUser.current_room || 'open-space'}
- Online Presence Status: ${isTargetOffline ? 'Offline (Currently logged out / session timed out)' : (targetUser.status_text || 'Active')}
- Working Hours: ${targetUser.assistant_work_start || '09:00'} - ${targetUser.assistant_work_end || '17:30'}
- Today's Available Common Free Slots:
${freeSlotsText}
- Sender (${req.user.name})'s Native Language: ${senderLangName}
- Target (${targetUser.name})'s Native Language: ${targetLangName}

Instructions:
1. If the sender is asking for a meeting or chat, suggest the available free slots clearly.
2. ${isDifferentLang ? `Generate a bilingual response. First, write the response in ${targetLangName} (${targetUser.name}'s language). Then, provide the translation in ${senderLangName} (the sender's language) so both parties can read it.` : `Respond politely and naturally in ${senderLangName}.`}
3. If ${targetUser.name} is Offline, in 'focus-zone', or in 'meeting-room', state that they are currently unavailable and take a message.
4. Output only the final assistant chat response without any meta commentary.`;

                            const ollamaRes = await fetch(`${host}/api/generate`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model,
                                    prompt: `Team Member (${req.user.name}) says: "${text}"`,
                                    system: systemInstruction,
                                    stream: false,
                                    options: { temperature: 0.3 }
                                })
                            });

                            if (ollamaRes.ok) {
                                const data = await ollamaRes.json();
                                const rawReply = (data.response || '').trim();
                                if (rawReply) {
                                    replyText = isDifferentLang ? `🤖 [AI Assistant (Gemma 4 🦙)]\n${rawReply}` : rawReply;
                                    isAssistant = true;
                                }
                            }
                        } catch (gemmaErr) {
                            console.error("Local Gemma 4 assistant reply error:", gemmaErr.message);
                        }
                    }

                    // 3. Gemini / Claude による動的応答生成の試行 (Local AI 未使用または失敗時)
                    if (!replyText) {
                        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
                        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
                        const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

                        if (apiKey || claudeApiKey) {
                            try {
                                const defaultPrompt = await db.getSetting('DEFAULT_ASSISTANT_PROMPT') || '';
                                const basePrompt = targetUser.assistant_prompt || defaultPrompt;

                                let finalSystemInstruction = basePrompt
                                    .replace(/{name}/g, targetUser.name)
                                    .replace(/{room}/g, isTargetOffline ? 'offline' : (targetUser.current_room || 'open-space'))
                                    .replace(/{work_start}/g, targetUser.assistant_work_start || '09:00')
                                    .replace(/{work_end}/g, targetUser.assistant_work_end || '17:30')
                                    .replace(/{free_slots}/g, freeSlotsText !== 'なし' ? freeSlotsText : 'なし');

                                const contextText = `
【現在のリアルタイム・コンテキスト】
- 主人の名前: ${targetUser.name}
- 主人の現在の部屋状態: ${targetUser.current_room || 'open-space'}
- 主人の現在のオンライン状態: ${isTargetOffline ? 'Offline (オフライン・ログアウト中)' : (targetUser.status_text || 'Active')}
- 本日の双方の共通空き時間帯: 
${freeSlotsText}
- 送信者 (${req.user.name}) の母国語: ${senderLangName}
- 主人 (${targetUser.name}) の母国語: ${targetLangName}
`;
                                const langInstruction = isDifferentLang 
                                    ? `【注意事項】必ずバイリンガルで回答してください。まず主人が読めるように ${targetLangName} で書き、その後に送信者が読めるように ${senderLangName} で翻訳を添えてください。` 
                                    : `【注意事項】自然な ${senderLangName} で丁寧に回答してください。`;
                                
                                finalSystemInstruction += `\n\n${contextText}\n\n${langInstruction}`;

                                if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
                                    const claudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
                                    replyText = (await llmAdapter.generateTextWithClaude({
                                        apiKey: claudeApiKey,
                                        model: claudeModel,
                                        prompt: `ユーザーからのメッセージ: "${text}"`,
                                        systemInstruction: finalSystemInstruction,
                                        temperature: 0.5
                                    })).trim();
                                } else if (apiKey) {
                                    const { GoogleGenAI } = require("@google/genai");
                                    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
                                    const modelName = await db.getSetting('GEMINI_MODEL') || 'gemini-2.5-flash';

                                    const aiResponse = await client.models.generateContent({
                                        model: modelName,
                                        contents: `ユーザーからのメッセージ: "${text}"`,
                                        config: {
                                            systemInstruction: finalSystemInstruction,
                                            temperature: 0.5
                                        }
                                    });
                                    replyText = (aiResponse.text || '').trim();
                                }
                                if (replyText) isAssistant = true;
                            } catch (aiErr) {
                                console.error("Failed to generate assistant reply using AI:", aiErr);
                            }
                        }
                    }

                    // 4. APIエラーまたはAPIキー未設定時のフォールバック（従来のハードコード分岐）
                    if (!replyText) {
                        const userText = (text || '');
                        const isMeetingRequest = userText.includes('打ち合わせ') || 
                                                 userText.includes('会議') || 
                                                 userText.includes('ミーティング') || 
                                                 userText.includes('話');

                        if (isTargetOffline) {
                            isAssistant = true;
                            if (isMeetingRequest && freeSlotsText !== 'なし') {
                                replyText = `現在 ${targetUser.name} はオフライン（退席中）のため、代わりにアシスタントの私が日程を調整します。本日共通で空いている時間は以下になります。仮登録されますか？\n${freeSlotsText}\n➔ [💻 ミーティングを仮調整する]`;
                            } else {
                                replyText = `現在 ${targetUser.name} はオフラインのため、代わりにアシスタントの私がご用件を承ります。次回ログイン時に伝言をお届けしますね！🙇‍♂️`;
                            }
                        } else if (targetUser.current_room === 'focus-zone') {
                            replyText = `すみません、現在 ${targetUser.name} は「集中ゾーン」で別作業に没頭しているため、応答できません。代わりにアシスタントの私が後ほど伝言を伝えておきますね！🙇‍♂️`;
                            isAssistant = true;
                        } else if (targetUser.current_room === 'remote') {
                            if (isMeetingRequest) {
                                isAssistant = true;
                                if (freeSlotsText !== 'なし') {
                                    if (isOvertime) {
                                        const workStartFormatted = targetUser.assistant_work_start || '09:00';
                                        const workEndFormatted = targetUser.assistant_work_end || '17:30';
                                        const bufferMin = targetUser.assistant_meeting_buffer !== undefined ? targetUser.assistant_meeting_buffer : 30;
                                        replyText = `${targetUser.name} の就業時間は ${workStartFormatted}〜${workEndFormatted} まで（最終受付は終了 ${bufferMin}分前）となっておりますが、本日就業時間内に共通の空き時間がございません。もしお急ぎでしたら時間外になりますが以下の時間帯で調整可能か、本人（BOSS）に確認いたしますがいかがでしょうか？\n${freeSlotsText}\n➔ [💻 時間外でBOSSに確認する]`;
                                    } else if (isBufferMitigated) {
                                        replyText = `${targetUser.name} はリモートワーク中のため、代わりにアシスタントの私が日程を調整します。就業終了間際（設定されたバッファ時間内）になりますが、本日就業時間内に共通で空いている時間は以下になります。仮登録されますか？\n${freeSlotsText}\n➔ [💻 ミーティングを仮調整する]`;
                                    } else {
                                        replyText = `${targetUser.name} はリモートワーク中のため、代わりにアシスタントの私が日程を調整します。お二人のカレンダーを確認したところ、本日共通で空いている時間は以下になります。仮登録されますか？\n${freeSlotsText}\n➔ [💻 ミーティングを仮調整する]`;
                                    }
                                } else {
                                    replyText = `${targetUser.name} はリモートワーク中のため、代わりにアシスタントの私が日程を調整します。本日中はお互いのカレンダーに共通して空いている時間帯（30分以上）が見当たりませんでした。個別調整が必要ですので、後ほど伝えておきます！`;
                                }
                            } else {
                                replyText = `${targetUser.name} は現在リモート勤務中ですが、アシスタントの私から本人にチャットが届いている旨をプッシュ通知で伝えておきますね！ご用件をこのままお書きください。`;
                                isAssistant = true;
                            }
                        } else if (targetUser.current_room && targetUser.current_room.startsWith('meeting-room')) {
                            replyText = `現在 ${targetUser.name} は「会議室」で打ち合わせ中のため、代理でアシスタントが受け付けております。会議が終わり次第、本人が対応いたします。`;
                            isAssistant = true;
                        }
                    }

                    if (replyText) {
                        setTimeout(() => {
                            db.run(
                                "INSERT INTO dm_messages (sender_id, receiver_id, sender_type, text, is_read) VALUES (?, ?, ?, ?, 1)",
                                [receiverId, loginUserId, isAssistant ? 'assistant' : 'user', replyText],
                                (err) => {
                                    if (err) console.error("Failed to insert auto reply:", err);
                                }
                            );
                        }, 1000);
                    }

                    res.json({ status: 'ok', messageId: insertedId });
                });
            }
        );
    });
});

// ==========================================
// USER PREFERENCES API
// ==========================================
app.get('/api/user/preferences', requireAuth, (req, res) => {
    db.get("SELECT window_state FROM user_preferences WHERE user_id = ?", [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ windowState: row ? JSON.parse(row.window_state) : [] });
    });
});

app.post('/api/user/preferences', requireAuth, (req, res) => {
    const { windowState } = req.body;
    db.run(`INSERT OR REPLACE INTO user_preferences (user_id, window_state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [req.user.id, JSON.stringify(windowState)],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// ==========================================
// MEMOS API
// ==========================================
app.get('/api/memos', requireAuth, (req, res) => {
    db.all("SELECT * FROM memos WHERE user_id = ?", [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/memos', requireAuth, (req, res) => {
    const { id, content, color, x, y, width, height, zIndex } = req.body;
    db.run(`INSERT INTO memos (id, user_id, content, color, x, y, width, height, z_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, content, color, x, y, width, height, zIndex],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.put('/api/memos/:id', requireAuth, (req, res) => {
    const { content, color, x, y, width, height, zIndex } = req.body;
    db.run(`UPDATE memos SET content = ?, color = ?, x = ?, y = ?, width = ?, height = ?, z_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
        [content, color, x, y, width, height, zIndex, req.params.id, req.user.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.delete('/api/memos/:id', requireAuth, (req, res) => {
    db.run("DELETE FROM memos WHERE id = ? AND user_id = ?", [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==========================================
// Static File Serving & Runtime Env Injection
// ==========================================
// path and fs are already required at the top of the file

// Serve static assets from Vite build output
app.use(express.static(path.join(__dirname, '../dist'), { index: false }));

// Fallback route for SPA - inject runtime environment variables into index.html
app.use((req, res, next) => {
    // Exclude API routes from this fallback
    if (req.path.startsWith('/api/')) {
        return next();
    }

    const indexFile = path.join(__dirname, '../dist/index.html');

    fs.readFile(indexFile, 'utf8', async (err, data) => {
        if (err) {
            console.error('Error reading index.html:', err);
            return res.status(500).send('Error loading application. Please ensure the frontend has been built.');
        }

        // Get the Client ID from DB or Env, falling back to empty string
        const clientId = await db.getSetting('GOOGLE_CLIENT_ID') || process.env.VITE_GOOGLE_CLIENT_ID || '';
        const apiUrl = process.env.VITE_API_URL || '';
        const gaMeasurementId = process.env.VITE_GA_MEASUREMENT_ID || '';

        // Prepare the environment object to inject
        const envConfig = {
            VITE_GOOGLE_CLIENT_ID: clientId,
            VITE_API_URL: apiUrl,
            VITE_GA_MEASUREMENT_ID: gaMeasurementId
        };

        // Inject the configuration into the <head> of index.html
        const injectedData = data.replace(
            '<head>',
            `<head><script>window.ENV = ${JSON.stringify(envConfig)};</script>`
        );

        // Set headers to prevent aggressive caching of index.html by browsers (especially Safari)
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        res.send(injectedData);
    });
});

const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log("Gemini API endpoint configured with @google/genai");
});

// Gemini 3.8 Multimodal Live API WebSocket Proxy
const { setupGeminiLiveWebSocket } = require('./routes/geminiLive.cjs');
setupGeminiLiveWebSocket(server);

// Graceful shutdown
async function gracefulShutdown(signal) {
    console.log(`\n${signal} signal received. Cancelling background jobs and shutting down...`);
    try {
        await deepResearchModule.cancelInProgressJobs();
    } catch (e) {
        console.error('Error during graceful shutdown:', e);
    }
    server.close(() => {
        console.log('HTTP server closed');
        try {
            // Check if db object has close method 
            if (db && typeof db.close === 'function') {
                db.close();
                console.log('Database connection closed');
            }
        } catch(err) {
            console.error('Error closing DB:', err.message);
        }
        process.exit(0);
    });
    
    // Fallback if server doesn't close after 10s
    setTimeout(() => {
        console.error('Forcing shutdown after 10s timeout');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
