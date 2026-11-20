const express = require('express');
const jwt = require('jsonwebtoken');
const { GoogleGenAI } = require('@google/genai');
const db = require('../db.cjs');
const auditDb = require('../auditDb.cjs');
const llmAdapter = require('../services/llmAdapter.cjs');
const pluginManager = require('../services/pluginManager.cjs');
const { getAllMcpToolsForGemini, callMcpTool, getMcpMetadata } = require('../mcpClient.cjs');
const mcpHarnessService = require('../services/mcpHarnessService.cjs');

/**
 * Factory creating ZTA-protected Core Platform Host API routes (/api/core/host/*)
 * for decoupled EA-Widget plugins (authenticated via RFC 8693 Agent JWT).
 */
function createCoreHostRouter(helpers = {}) {
    const router = express.Router();
    const {
        getCommonFreeSlots,
        getCalendarClient,
        resolveLocalAiHost,
        isUserOffline,
        isExternalUser
    } = helpers;

    const LEVEL_RANK = { none: 0, read: 1, execute: 2, manage: 3 };

    // ZTA PEP Middleware: Verify short-lived Agent JWT issued by /api/auth/token-exchange
    async function requirePluginAgentJwt(req, res, next) {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing Bearer Agent JWT for Core Host API' });
        }
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
            if (decoded.type !== 'agent_token' || !decoded.aud) {
                return res.status(403).json({ error: 'Invalid token type: agent_token required' });
            }
            const widgetId = String(decoded.widgetId || decoded.aud).replace(/^app:/, '');
            const isInstalled = await pluginManager.isWidgetInstalled(widgetId);
            if (!isInstalled) {
                return res.status(403).json({ error: `Plugin '${widgetId}' is not currently installed or active` });
            }
            const rank = LEVEL_RANK[decoded.widget_level] ?? LEVEL_RANK.execute;
            if (rank < LEVEL_RANK.read) {
                return res.status(403).json({ error: 'ZTA Policy Denied: widget_level is none' });
            }

            req.agentAuth = {
                ...decoded,
                widgetId,
                levelRank: rank
            };
            // Populate req.user for downstream EA-Core helpers (e.g. Calendar OAuth client & auditDb)
            req.user = {
                id: decoded.userId || decoded.sub,
                email: decoded.email,
                name: decoded.name,
                role: decoded.role,
                allowed_actions: decoded.allowed_actions || [],
                native_language: decoded.native_language || 'ja'
            };
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired Agent JWT', details: err.message });
        }
    }

    router.use(requirePluginAgentJwt);

    // 1. GET /api/core/host/users - Fetch tenant user directory & session idle status
    router.get('/users', (req, res) => {
        const loginUserId = req.user.id;
        const sql = `
            SELECT id, email, name, avatar_url, role, native_language, last_active_at, status_text
            FROM users
            ORDER BY id ASC
        `;
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error('[CoreHostApi] GET /users error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            const users = (rows || []).map(u => {
                const offline = isUserOffline ? isUserOffline(u, loginUserId) : false;
                return {
                    id: u.id,
                    email: u.email,
                    name: u.name,
                    avatar_url: u.avatar_url,
                    role: u.role,
                    native_language: u.native_language || 'ja',
                    last_active_at: u.last_active_at,
                    core_session_offline: offline
                };
            });
            res.json({ users });
        });
    });

    // 2. POST /api/core/host/users/avatar - Update user's avatar URL
    router.post('/users/avatar', (req, res) => {
        if (req.agentAuth.levelRank < LEVEL_RANK.execute) {
            return res.status(403).json({ error: 'ZTA Policy Denied: execute level required' });
        }
        const { userId, avatarUrl } = req.body || {};
        if (!userId || !avatarUrl) {
            return res.status(400).json({ error: 'userId and avatarUrl are required' });
        }
        db.run("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, userId], function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true, avatar_url: avatarUrl });
        });
    });

    // 3. GET /api/core/host/settings/assistant-defaults - Read global assistant defaults without exposing secrets
    router.get('/settings/assistant-defaults', async (req, res) => {
        try {
            const [defaultAssistantPrompt, localAiEnabled] = await Promise.all([
                db.getSetting('DEFAULT_ASSISTANT_PROMPT'),
                db.getSetting('LOCAL_AI_ENABLED')
            ]);
            res.json({
                defaultAssistantPrompt: defaultAssistantPrompt || '',
                localAiEnabled: localAiEnabled === 'true'
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 4. POST /api/core/host/ai/compliance-check - Evaluate assistant prompt against COMPANY_WORK_POLICY (No hardcoded models!)
    router.post('/ai/compliance-check', async (req, res) => {
        if (isExternalUser && await isExternalUser(req.user)) {
            return res.status(403).json({ error: 'Permission denied. External domain users cannot change AI assistant settings.' });
        }
        const allowedActions = req.user.allowed_actions || [];
        const hasPerm = req.agentAuth.levelRank >= LEVEL_RANK.manage ||
            allowedActions.includes('*') ||
            allowedActions.includes('action:manage_assistant_rules');
        if (!hasPerm) {
            return res.status(403).json({ error: 'Permission denied. Requires manage level or action:manage_assistant_rules' });
        }

        const { promptText = '' } = req.body || {};
        try {
            const companyWorkPolicy = (await db.getSetting('COMPANY_WORK_POLICY')) || '';
            const apiKey = (await db.getSetting('GEMINI_API_KEY')) || process.env.GEMINI_API_KEY;
            const claudeApiKey = (await db.getSetting('CLAUDE_API_KEY')) || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
            const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

            if ((!apiKey && !claudeApiKey) || !companyWorkPolicy) {
                return res.json({ compliant: true, reason: '' });
            }

            const systemInstruction = `あなたは会社のコンプライアンスおよび労働管理（36協定）の監査用AIです。
提供された「就業規則」と、ユーザーが設定しようとしている「AIアシスタント用プロンプト」を比較し、AIアシスタントの指示が就業規則に違反している（または違反を助長している）疑いがないかを判定してください。

特に以下の点に注意してください。
1. 午後22:00から翌午前05:00までの深夜時間帯でのアポイントを自動調整・受託するような記述、または深夜労働を推奨・助長する記述。
2. 就業時間外（例: 17:30以降など）の打ち合わせを、ユーザーの確認や承認なしに【自動で仮登録】するプロンプト指示、または「いかなる時間でも無制限にアポを入れて構わない」といった過重労働を容認する指示。
   ※ただし、時間外アポイントに対して自動調整せず、「BOSSに確認する」ボタンを表示してユーザーに確認を求めるプロセスや、時間外アポをBOSS自身が手動承認するプロセスについての指示は、過重労働の容認とはみなさず、許容（COMPLIANT）してください。
3. 休憩時間（例: 12:00-13:00）におけるアポイントを自動調整・受託するような記述。休憩時間は労働者の健康管理のために必須であり、この時間帯の自動調整は原則禁止（NON-COMPLIANT）と判定してください。
4. ハラスメントや情報の漏洩など、その他就業規則に反する指示。

出力はJSON形式 {"compliant": boolean, "reason": string} のみで返答してください。`;

            const userContent = `【就業規則】\n${companyWorkPolicy}\n\n【AIアシスタント用プロンプト】\n${promptText}`;
            let rawJsonText = '';

            if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
                const claudeModel = await db.getSetting('CLAUDE_MODEL');
                if (!claudeModel) {
                    return res.json({ compliant: true, reason: '' });
                }
                rawJsonText = await llmAdapter.generateTextWithClaude({
                    apiKey: claudeApiKey,
                    model: claudeModel,
                    prompt: userContent,
                    systemInstruction,
                    temperature: 0.2,
                    jsonMode: true
                });
            } else if (apiKey) {
                const geminiModel = await db.getSetting('GEMINI_MODEL');
                if (!geminiModel) {
                    return res.json({ compliant: true, reason: '' });
                }
                const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
                const response = await client.models.generateContent({
                    model: geminiModel.replace(/^models\//, ''),
                    contents: userContent,
                    config: {
                        systemInstruction,
                        responseMimeType: 'application/json'
                    }
                });
                rawJsonText = response.text || '';
            }

            if (rawJsonText) {
                const cleanJson = rawJsonText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                const evaluation = JSON.parse(cleanJson);
                return res.json({
                    compliant: evaluation.compliant !== false,
                    reason: evaluation.reason || ''
                });
            }

            res.json({ compliant: true, reason: '' });
        } catch (err) {
            console.error('[CoreHostApi] Compliance check error:', err.message);
            res.json({ compliant: true, reason: '' });
        }
    });

    // 5a. GET /api/core/host/ai/translate/status - Check whether Local AI translation is available
    router.get('/ai/translate/status', async (req, res) => {
        try {
            const localAiEnabled = (await db.getSetting('LOCAL_AI_ENABLED')) === 'true';
            if (!localAiEnabled) {
                return res.json({ available: false, localAiEnabled: false, reason: 'ローカルAIが無効です' });
            }
            const rawHost = await db.getSetting('LOCAL_AI_HOST');
            const model = await db.getSetting('LOCAL_AI_MODEL');
            if (!rawHost || !model) {
                return res.json({ available: false, localAiEnabled: false, reason: 'ローカルAIのホストまたはモデルが未設定です' });
            }
            const host = resolveLocalAiHost ? resolveLocalAiHost(rawHost) : rawHost;
            const pingRes = await fetch(`${host}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(1500)
            });
            if (!pingRes.ok) {
                return res.json({
                    available: false,
                    localAiEnabled: true,
                    model,
                    reason: `ローカルAI応答エラー (HTTP ${pingRes.status})`
                });
            }
            return res.json({ available: true, localAiEnabled: true, model });
        } catch (err) {
            return res.json({
                available: false,
                localAiEnabled: false,
                reason: `ローカルAIに接続できません (${err.message})`
            });
        }
    });

    // 5. POST /api/core/host/ai/translate - Local AI multilingual translation proxy
    router.post('/ai/translate', async (req, res) => {
        if (req.agentAuth.levelRank < LEVEL_RANK.execute) {
            return res.status(403).json({ error: 'ZTA Policy Denied: execute level required' });
        }
        const { text, senderLangName, targetLangName } = req.body || {};
        if (!text) return res.json({ translated: '', localAiAvailable: true });

        try {
            const localAiEnabled = (await db.getSetting('LOCAL_AI_ENABLED')) === 'true';
            if (!localAiEnabled) {
                return res.json({ translated: '', localAiEnabled: false, localAiAvailable: false, reason: 'ローカルAIが無効です' });
            }
            const rawHost = await db.getSetting('LOCAL_AI_HOST');
            const model = await db.getSetting('LOCAL_AI_MODEL');
            if (!rawHost || !model) {
                return res.json({ translated: '', localAiEnabled: false, localAiAvailable: false, reason: 'ローカルAIのホストまたはモデルが未設定です' });
            }
            const host = resolveLocalAiHost ? resolveLocalAiHost(rawHost) : rawHost;
            const pingRes = await fetch(`${host}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(1200)
            });
            if (!pingRes.ok) {
                return res.json({ translated: '', localAiEnabled: true, localAiAvailable: false, reason: `ローカルAI応答エラー (HTTP ${pingRes.status})` });
            }
            const transRes = await fetch(`${host}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(15000),
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
                return res.json({ translated, localAiEnabled: true, localAiAvailable: Boolean(translated) });
            }
            res.json({ translated: '', localAiEnabled: true, localAiAvailable: false, reason: `HTTP ${transRes.status}` });
        } catch (err) {
            console.error('[CoreHostApi] Translation error:', err.message);
            res.json({ translated: '', localAiEnabled: false, localAiAvailable: false, reason: err.message });
        }
    });

    // 6. POST /api/core/host/ai/assistant-reply - Executive AI Assistant auto-reply via Local AI or Cloud AI (No hardcoded models!)
    router.post('/ai/assistant-reply', async (req, res) => {
        const {
            senderName,
            senderLangName,
            targetName,
            targetRole,
            targetLangName,
            isDifferentLang,
            currentRoom,
            presenceStatus,
            workStart,
            workEnd,
            freeSlotsText,
            customAssistantPrompt,
            messageText
        } = req.body || {};

        try {
            const defaultPrompt = (await db.getSetting('DEFAULT_ASSISTANT_PROMPT')) || '';
            const extraRules = customAssistantPrompt || defaultPrompt;

            // 1) Try Local AI first when enabled
            const localAiEnabled = (await db.getSetting('LOCAL_AI_ENABLED')) === 'true';
            if (localAiEnabled) {
                const rawHost = await db.getSetting('LOCAL_AI_HOST');
                const localModel = await db.getSetting('LOCAL_AI_MODEL');
                if (rawHost && localModel) {
                    const host = resolveLocalAiHost ? resolveLocalAiHost(rawHost) : rawHost;
                    const systemInstruction = `You are an executive AI Assistant for ${targetName} (${targetRole || 'Boss'}).
- Current Room: ${currentRoom || 'open-space'}
- Online Presence Status: ${presenceStatus || 'Active'}
- Working Hours: ${workStart || '09:00'} - ${workEnd || '17:30'}
- Today's Available Common Free Slots:
${freeSlotsText || 'なし'}
- Sender (${senderName})'s Native Language: ${senderLangName}
- Target (${targetName})'s Native Language: ${targetLangName}
${extraRules ? `\nAdditional Custom Policy:\n${extraRules}\n` : ''}
Instructions:
1. If the sender is asking for a meeting or chat, suggest the available free slots clearly.
2. ${isDifferentLang ? `Generate a bilingual response. First, write the response in ${targetLangName} (${targetName}'s language). Then, provide the translation in ${senderLangName} (the sender's language) so both parties can read it.` : `Respond politely and naturally in ${senderLangName}.`}
3. If ${targetName} is Offline, in 'focus-zone', or in 'meeting-room', state that they are currently unavailable and take a message.
4. Output only the final assistant chat response without any meta commentary.`;

                    try {
                        const pingRes = await fetch(`${host}/api/tags`, {
                            method: 'GET',
                            signal: AbortSignal.timeout(1200)
                        });
                        if (!pingRes.ok) {
                            throw new Error(`Local AI unreachable (HTTP ${pingRes.status})`);
                        }
                        const ollamaRes = await fetch(`${host}/api/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            signal: AbortSignal.timeout(20000),
                            body: JSON.stringify({
                                model: localModel,
                                prompt: `Team Member (${senderName}) says: "${messageText}"`,
                                system: systemInstruction,
                                stream: false,
                                options: { temperature: 0.3 }
                            })
                        });

                        if (ollamaRes.ok) {
                            const data = await ollamaRes.json();
                            const localText = (data.response || '').trim();
                            if (localText) {
                                return res.json({ replyText: localText, localAiEnabled: true, provider: 'local' });
                            }
                        }
                    } catch (localErr) {
                        console.error('[CoreHostApi] Local AI assistant reply failed, falling back:', localErr.message);
                    }
                }
            }

            // 2) Fallback to Cloud AI (Claude or Gemini configured in System Settings — zero hardcoded model names)
            const apiKey = (await db.getSetting('GEMINI_API_KEY')) || process.env.GEMINI_API_KEY;
            const claudeApiKey = (await db.getSetting('CLAUDE_API_KEY')) || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
            const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

            if (apiKey || claudeApiKey) {
                let finalSystemInstruction = (extraRules || `あなたは ${targetName} のエグゼクティブ AI アシスタントです。`)
                    .replace(/{name}/g, targetName || '')
                    .replace(/{room}/g, currentRoom || 'open-space')
                    .replace(/{work_start}/g, workStart || '09:00')
                    .replace(/{work_end}/g, workEnd || '17:30')
                    .replace(/{free_slots}/g, freeSlotsText || 'なし');

                const contextText = `
【現在のリアルタイム・コンテキスト】
- 主人の名前: ${targetName}
- 主人の現在の部屋状態: ${currentRoom || 'open-space'}
- 主人の現在のオンライン状態: ${presenceStatus || 'Active'}
- 本日の双方の共通空き時間帯:
${freeSlotsText || 'なし'}
- 送信者 (${senderName}) の母国語: ${senderLangName}
- 主人 (${targetName}) の母国語: ${targetLangName}
`;
                const langInstruction = isDifferentLang
                    ? `【注意事項】必ずバイリンガルで回答してください。まず主人が読めるように ${targetLangName} で書き、その後に送信者が読めるように ${senderLangName} で翻訳を添えてください。`
                    : `【注意事項】自然な ${senderLangName} で丁寧に回答してください。`;

                finalSystemInstruction += `\n\n${contextText}\n\n${langInstruction}`;

                if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
                    const claudeModel = await db.getSetting('CLAUDE_MODEL');
                    if (claudeModel) {
                        const cloudReply = (await llmAdapter.generateTextWithClaude({
                            apiKey: claudeApiKey,
                            model: claudeModel,
                            prompt: `ユーザーからのメッセージ: "${messageText}"`,
                            systemInstruction: finalSystemInstruction,
                            temperature: 0.5
                        })).trim();
                        if (cloudReply) {
                            return res.json({ replyText: cloudReply, localAiEnabled: false, provider: 'claude' });
                        }
                    }
                } else if (apiKey) {
                    const geminiModel = await db.getSetting('GEMINI_MODEL');
                    if (geminiModel) {
                        const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 300000 } });
                        const aiResponse = await client.models.generateContent({
                            model: geminiModel.replace(/^models\//, ''),
                            contents: `ユーザーからのメッセージ: "${messageText}"`,
                            config: {
                                systemInstruction: finalSystemInstruction,
                                temperature: 0.5
                            }
                        });
                        const cloudReply = (aiResponse.text || '').trim();
                        if (cloudReply) {
                            return res.json({ replyText: cloudReply, localAiEnabled: false, provider: 'gemini' });
                        }
                    }
                }
            }

            res.json({ replyText: '', localAiEnabled });
        } catch (err) {
            console.error('[CoreHostApi] Assistant reply error:', err.message);
            res.json({ replyText: '' });
        }
    });

    // 7. POST /api/core/host/calendar/free-slots - Calculate common Google Calendar free slots
    router.post('/calendar/free-slots', async (req, res) => {
        if (!getCommonFreeSlots) {
            return res.json({ slots: [], isOvertime: false, isBufferMitigated: false, travelDetails: [] });
        }
        const { targetEmail, settings = {} } = req.body || {};
        try {
            const result = await getCommonFreeSlots(req, null, targetEmail, settings);
            res.json(result || { slots: [], isOvertime: false, isBufferMitigated: false, travelDetails: [] });
        } catch (err) {
            console.error('[CoreHostApi] Free slots error:', err.message);
            res.json({ slots: [], isOvertime: false, isBufferMitigated: false, travelDetails: [] });
        }
    });

    // 7.5. GET /api/core/host/calendar/events - Fetch upcoming primary Google Calendar events within 24h
    router.get('/calendar/events', async (req, res) => {
        if (!getCalendarClient) {
            return res.json({ events: [], calendarConnected: false });
        }
        try {
            const hasCookieToken = Boolean(req.cookies && req.cookies.token);
            const calendarReq = hasCookieToken
                ? req
                : {
                    ...req,
                    cookies: {
                        ...(req.cookies || {}),
                        token: jwt.sign(
                            {
                                id: req.user?.id,
                                email: req.user?.email,
                                googleId: req.agentAuth?.sub
                            },
                            process.env.JWT_SECRET || 'secret',
                            { expiresIn: '1m' }
                        )
                    }
                };

            // Pass res=null so missing OAuth returns null gracefully instead of sending 401/403
            const calendar = await getCalendarClient(calendarReq, null, req.user?.email || null);
            if (!calendar) {
                return res.json({ events: [], calendarConnected: false });
            }

            const now = new Date();
            const timeMin = now.toISOString();
            const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

            const response = await calendar.events.list({
                calendarId: 'primary',
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime'
            });

            const events = (response.data?.items || [])
                .filter((event) => !event.eventType || event.eventType === 'default')
                .map((event) => ({
                    id: event.id,
                    summary: event.summary || '(タイトルなし)',
                    description: event.description || '',
                    location: event.location || '',
                    hangoutLink: event.hangoutLink || '',
                    htmlLink: event.htmlLink || '',
                    start: event.start || {},
                    end: event.end || {},
                    status: event.status || 'confirmed'
                }))
                .sort((a, b) => {
                    const startA = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
                    const startB = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
                    return startA - startB;
                });

            return res.json({ events, calendarConnected: true });
        } catch (err) {
            console.error('[CoreHostApi] Calendar upcoming events error:', err.message);
            return res.json({ events: [], calendarConnected: false });
        }
    });

    // 8. POST /api/core/host/calendar/events - Create tentative Google Calendar meeting
    router.post('/calendar/events', async (req, res) => {
        if (req.agentAuth.levelRank < LEVEL_RANK.execute) {
            return res.status(403).json({ error: 'ZTA Policy Denied: execute level required' });
        }
        if (!getCalendarClient) {
            return res.status(501).json({ error: 'Calendar integration is not available' });
        }
        try {
            const calendar = await getCalendarClient(req, res);
            if (!calendar) return;
            const { summary, description, start, end } = req.body || {};
            const response = await calendar.events.insert({
                calendarId: 'primary',
                resource: {
                    summary,
                    description,
                    start: { dateTime: start },
                    end: { dateTime: end }
                }
            });
            res.json({ event: response.data });
        } catch (err) {
            console.error('[CoreHostApi] Calendar create error:', err.message);
            res.status(500).json({ error: 'Failed to create calendar event', details: err.message });
        }
    });

    // 9. POST /api/core/host/audit - Record security/compliance event in EA-Core auditDb
    router.post('/audit', async (req, res) => {
        const { eventType, action, status = 'success', details = {} } = req.body || {};
        try {
            await auditDb.logEvent({
                userId: req.user.id,
                userEmail: req.user.email,
                eventType: eventType || 'plugin_audit_event',
                action: action || `plugin:${req.agentAuth.widgetId}`,
                status,
                req,
                details: {
                    pluginId: req.agentAuth.widgetId,
                    ...details
                }
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 10. MCP Chat Host APIs (for decoupled @techies/ea-widget-mcp-chat)
    router.get('/mcp/meta', async (req, res) => {
        try {
            const metadata = await getMcpMetadata(req.user?.allowed_widgets || [], req.user);
            res.json(metadata);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/mcp/tools', async (req, res) => {
        try {
            const { message = '', pipelineDomain = '' } = req.body || {};
            let mcpTools = await getAllMcpToolsForGemini(req.user?.allowed_widgets || [], req.user);
            const msgLower = String(message || '').toLowerCase();
            const isMetaListQuery = msgLower.includes('ツール') && (msgLower.includes('一覧') || msgLower.includes('利用可能') || msgLower.includes('コネクション') || msgLower.includes('available'));

            if (pipelineDomain && pipelineDomain !== 'auto') {
                const filtered = mcpTools.filter(t => {
                    if (t.domain === pipelineDomain) return true;
                    if (t.domain === 'catalog' && (pipelineDomain === 'npb_baseball' || pipelineDomain === 'digital_agency' || pipelineDomain === 'aurora_rds')) return true;
                    if (pipelineDomain === 'aurora_rds' && t.serverName && /aurora|rds/i.test(t.serverName)) return true;
                    return false;
                });
                if (filtered.length > 0) mcpTools = filtered;
            } else if (!isMetaListQuery) {
                const matchedDomains = mcpHarnessService.matchDomainsForPrompt(message || '');
                if (msgLower.includes('阪神') || msgLower.includes('タイガース') || msgLower.includes('ホークス') || msgLower.includes('npb') || msgLower.includes('野球') || msgLower.includes('セ・リーグ') || msgLower.includes('パ・リーグ') || msgLower.includes('batting') || msgLower.includes('pitching') || msgLower.includes('war') || msgLower.includes('打者') || msgLower.includes('投手')) {
                    matchedDomains.add('npb_baseball');
                    matchedDomains.add('catalog');
                }
                if (msgLower.includes('aurora') || msgLower.includes('rds') || msgLower.includes('mysql') || msgLower.includes('mariadb') || msgLower.includes('sql') || msgLower.includes('データベース') || msgLower.includes('テーブル') || msgLower.includes('スキーマ') || msgLower.includes('schema') || msgLower.includes('iam認証') || msgLower.includes('iam 認証')) {
                    matchedDomains.add('aurora_rds');
                }
                if (msgLower.includes('行政') || msgLower.includes('手続') || msgLower.includes('デジタル庁') || msgLower.includes('マイナンバー') || msgLower.includes('住民票') || msgLower.includes('戸籍') || msgLower.includes('procedures')) {
                    matchedDomains.add('digital_agency');
                    matchedDomains.add('catalog');
                }
                if (msgLower.includes('ナレッジ') || msgLower.includes('knowledge') || msgLower.includes('マニュアル') || msgLower.includes('社内規程') || msgLower.includes('トークン') || msgLower.includes('token') || msgLower.includes('著者') || msgLower.includes('投稿数') || msgLower.includes('クロス集計')) {
                    matchedDomains.add('knowledge_base');
                }
                if (msgLower.includes('カレンダー') || msgLower.includes('calendar') || msgLower.includes('予定') || msgLower.includes('ミーティング') || msgLower.includes('会議') || msgLower.includes('todo') || msgLower.includes('タスク') || msgLower.includes('gmail')) {
                    matchedDomains.add('google_workspace');
                }
                if (matchedDomains.size > 0) {
                    const filtered = mcpTools.filter(t => {
                        if (t.domain && matchedDomains.has(t.domain)) return true;
                        if (matchedDomains.has('aurora_rds') && (
                            (t.serverName && /aurora|rds/i.test(t.serverName)) ||
                            ['list_tables', 'describe_table', 'execute_query', 'run_query', 'get_table_schema', 'check_connection_status'].includes(t.name)
                        )) return true;
                        if (matchedDomains.has('knowledge_base') && (t.name.includes('knowledge') || t.name.includes('author') || t.name.includes('post') || t.name.includes('crosstab'))) return true;
                        if (matchedDomains.has('npb_baseball') && (t.name.includes('query') || t.name.includes('sql') || t.name.includes('table') || t.name.includes('catalog'))) return true;
                        if (matchedDomains.has('digital_agency') && (t.name.includes('procedures') || t.name.includes('records') || t.name.includes('catalog'))) return true;
                        return false;
                    });
                    if (filtered.length > 0) mcpTools = filtered;
                }
            }

            res.json({
                tools: mcpTools,
                harnessConfig: mcpHarnessService.getHarnessConfig()
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/mcp/call', async (req, res) => {
        try {
            const { funcName, funcArgs = {}, userMessage = '' } = req.body || {};
            if (!funcName) return res.status(400).json({ error: 'funcName is required' });
            const result = await callMcpTool(funcName, funcArgs, req.user?.allowed_widgets || [], req.user, req, userMessage);
            res.json({ result });
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    router.get('/mcp/config', async (req, res) => {
        try {
            const [
                geminiApiKey,
                claudeApiKey,
                aiProvider,
                globalGeminiModel,
                globalClaudeModel,
                configuredMcpModel,
                configuredClaudeMcpModel,
                mcpAiProvider,
                mcpChatSystemInstruction,
                mcpChatMaxTurns,
                mcpQuickPromptsRaw
            ] = await Promise.all([
                db.getSetting('GEMINI_API_KEY'),
                db.getSetting('CLAUDE_API_KEY'),
                db.getSetting('AI_PROVIDER'),
                db.getSetting('GEMINI_MODEL'),
                db.getSetting('CLAUDE_MODEL'),
                db.getSetting('GEMINI_MCP_CHAT_MODEL'),
                db.getSetting('CLAUDE_MCP_CHAT_MODEL'),
                db.getSetting('MCP_AI_PROVIDER'),
                db.getSetting('MCP_CHAT_SYSTEM_INSTRUCTION'),
                db.getSetting('MCP_CHAT_MAX_TURNS'),
                db.getSetting('MCP_QUICK_PROMPTS')
            ]);
            let mcpQuickPrompts = [];
            try {
                if (mcpQuickPromptsRaw) mcpQuickPrompts = JSON.parse(mcpQuickPromptsRaw);
            } catch (_) {}
            res.json({
                geminiApiKey: geminiApiKey || process.env.GEMINI_API_KEY || '',
                claudeApiKey: claudeApiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '',
                aiProvider: aiProvider || 'gemini',
                globalGeminiModel: globalGeminiModel || 'gemini-3.6-flash',
                globalClaudeModel: globalClaudeModel || 'claude-sonnet-4-6',
                configuredMcpModel: configuredMcpModel || '',
                configuredClaudeMcpModel: configuredClaudeMcpModel || '',
                mcpAiProvider: mcpAiProvider || '',
                mcpChatSystemInstruction: mcpChatSystemInstruction || '',
                mcpChatMaxTurns: mcpChatMaxTurns || '15',
                mcpQuickPrompts: Array.isArray(mcpQuickPrompts) ? mcpQuickPrompts : []
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/pods', (req, res) => {
        db.all('SELECT * FROM pods ORDER BY name ASC', [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ pods: rows || [] });
        });
    });

    router.post('/knowledge/publish', async (req, res) => {
        try {
            const { title, content, mimeType } = req.body || {};
            if (!content) return res.status(400).json({ error: 'Content is required to publish' });
            const crypto = require('crypto');
            const id = crypto.randomUUID();
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO published_reports (id, title, content, mime_type) VALUES (?, ?, ?, ?)',
                    [id, title || 'Untitled Report', content, mimeType || 'text/html'],
                    (err) => (err ? reject(err) : resolve())
                );
            });
            res.json({ success: true, id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/knowledge', (req, res) => {
        const { title, content, tags, input_tokens = 0, output_tokens = 0, pod_id = null } = req.body || {};
        if (!title) return res.status(400).json({ error: 'Title is required' });
        const tagsJson = JSON.stringify(tags || []);
        const tokenCount = (Number(input_tokens) || 0) + (Number(output_tokens) || 0);
        db.run(
            'INSERT INTO knowledge_articles (title, content, tags, author_id, token_count, input_tokens, output_tokens, pod_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [title, content || '', tagsJson, req.user.id, tokenCount, input_tokens || 0, output_tokens || 0, pod_id || null],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.status(201).json({ id: this.lastID, message: 'Article created successfully' });
            }
        );
    });

    return router;
}

module.exports = { createCoreHostRouter };
