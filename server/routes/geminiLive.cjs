const express = require('express');
const router = express.Router();
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const db = require('../db.cjs');
const { extractKnowledgeContext } = require('../utils/knowledgeExtractor.cjs');

const { GoogleGenAI } = require('@google/genai');

/**
 * ユーザーの RBAC 許可 Pod 一覧を取得 (ZTA準拠)
 */
async function getAllowedPodsForUser(user) {
    if (!user) return [];
    try {
        const rbacPolicies = JSON.parse(await db.getSetting('RBAC_POLICIES') || '{}');
        const roles = (user.role || 'user').split(',').map(r => r.trim());
        let allowedPods = [];
        if (roles.includes('admin')) {
            allowedPods = ['*'];
        } else {
            roles.forEach(r => {
                const policy = rbacPolicies[r] || {};
                (policy.allowed_pods || []).forEach(p => {
                    if (!allowedPods.includes(p)) allowedPods.push(p);
                });
            });
        }
        return allowedPods;
    } catch (e) {
        console.error('[Gemini Live] Error reading RBAC policies:', e);
        return [];
    }
}

/**
 * 指定IDのナレッジ記事をRBAC検証付きで取得
 */
async function fetchArticleById(id, user) {
    const allowedPods = await getAllowedPodsForUser(user);
    const hasAllAccess = allowedPods.includes('*');

    return new Promise((resolve) => {
        db.get(`
            SELECT k.*, u.name as author_name,
                   CASE WHEN u.avatar_url LIKE 'data:%' THEN ('/api/users/' || u.id || '/avatar') ELSE u.avatar_url END as author_avatar
            FROM knowledge_articles k
            LEFT JOIN users u ON k.author_id = u.id
            WHERE k.id = ?
        `, [id], (err, row) => {
            if (err || !row) return resolve(null);
            if (!hasAllAccess && row.pod_id && !allowedPods.includes(row.pod_id)) {
                return resolve(null); // アクセス権限なし
            }
            // 記事内に /reports/<uuid> リンクが含まれている場合、published_reports テーブルから HTML 本体を自動取得
            const reportMatch = (row.content || '').match(/\/reports\/([0-9a-fA-F-]{36})/);
            if (reportMatch && reportMatch[1]) {
                db.get("SELECT content FROM published_reports WHERE id = ?", [reportMatch[1]], (repErr, repRow) => {
                    if (!repErr && repRow && repRow.content) {
                        row.publishedHtml = repRow.content;
                    }
                    resolve(row);
                });
            } else {
                resolve(row);
            }
        });
    });
}

/**
 * キーワードによるナレッジ記事の検索
 */
async function searchArticles(query, user, limit = 5) {
    const allowedPods = await getAllowedPodsForUser(user);
    const hasAllAccess = allowedPods.includes('*');

    return new Promise((resolve) => {
        let sql = `
            SELECT k.id, k.title, k.tags, k.created_at, k.updated_at 
            FROM knowledge_articles k
            WHERE (k.title LIKE ? OR k.tags LIKE ? OR k.content LIKE ?)
        `;
        const qParam = `%${query}%`;
        let params = [qParam, qParam, qParam];

        if (!hasAllAccess) {
            if (allowedPods.length > 0) {
                const placeholders = allowedPods.map(() => '?').join(',');
                sql += ` AND (k.pod_id IN (${placeholders}) OR k.pod_id IS NULL OR k.pod_id = '')`;
                params.push(...allowedPods);
            } else {
                sql += ` AND (k.pod_id IS NULL OR k.pod_id = '')`;
            }
        }
        sql += ` ORDER BY k.created_at DESC, k.id DESC LIMIT ?`;
        params.push(limit);

        db.all(sql, params, (err, rows) => {
            if (err) return resolve([]);
            const formatted = (rows || []).map(r => {
                try { r.tags = JSON.parse(r.tags || '[]'); } catch (_) { r.tags = []; }
                return r;
            });
            resolve(formatted);
        });
    });
}

/**
 * 最近保存されたナレッジ記事の一覧を取得
 */
async function listRecentArticles(limit = 10, user) {
    const allowedPods = await getAllowedPodsForUser(user);
    const hasAllAccess = allowedPods.includes('*');

    return new Promise((resolve) => {
        let sql = `
            SELECT k.id, k.title, k.tags, k.created_at, k.updated_at 
            FROM knowledge_articles k
            WHERE 1=1
        `;
        let params = [];

        if (!hasAllAccess) {
            if (allowedPods.length > 0) {
                const placeholders = allowedPods.map(() => '?').join(',');
                sql += ` AND (k.pod_id IN (${placeholders}) OR k.pod_id IS NULL OR k.pod_id = '')`;
                params.push(...allowedPods);
            } else {
                sql += ` AND (k.pod_id IS NULL OR k.pod_id = '')`;
            }
        }
        sql += ` ORDER BY k.created_at DESC, k.id DESC LIMIT ?`;
        params.push(limit);

        db.all(sql, params, (err, rows) => {
            if (err) return resolve([]);
            const formatted = (rows || []).map(r => {
                try { r.tags = JSON.parse(r.tags || '[]'); } catch (_) { r.tags = []; }
                return r;
            });
            resolve(formatted);
        });
    });
}

/**
 * 簡易 Cookie パーサー (外部依存なしで安全に抽出)
 */
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        try {
            list[name] = decodeURIComponent(value);
        } catch (_) {
            list[name] = value;
        }
    });
    return list;
}

/**
 * WebSocket upgrade ハンドラからユーザーを認証 (ZTA準拠)
 */
async function authenticateRequest(request) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.token;
    if (!token) return null;

    return new Promise((resolve) => {
        jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, decoded) => {
            if (err || !decoded) return resolve(null);
            
            // DBから最新のロールを取得して確認
            db.get("SELECT id, name, email, role FROM users WHERE id = ?", [decoded.id], (dbErr, user) => {
                if (dbErr || !user) return resolve(null);
                resolve(user);
            });
        });
    });
}

/**
 * REST API: Live Concierge 専用モデル一覧の動的取得
 * (ハードコード禁止原則に従い、DB の GEMINI_LIVE_AVAILABLE_MODELS 設定から動的に取得)
 */
router.get('/models', async (req, res) => {
    try {
        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const currentSavedModel = await db.getSetting('GEMINI_LIVE_MODEL');
        const defaultModel = await db.getSetting('GEMINI_LIVE_DEFAULT_MODEL') || 'gemini-3.8-live';

        // DB から Live モデル一覧を取得 (未設定時は初期シードを登録)
        let liveModels = [];
        const rawLiveModels = await db.getSetting('GEMINI_LIVE_AVAILABLE_MODELS');
        if (rawLiveModels) {
            try {
                liveModels = JSON.parse(rawLiveModels);
            } catch (parseErr) {
                console.warn('[Gemini Live API] Failed to parse GEMINI_LIVE_AVAILABLE_MODELS JSON:', parseErr);
            }
        }

        // 初期シードが空の場合はデフォルトを自動登録 (DB永続化)
        if (!Array.isArray(liveModels) || liveModels.length === 0) {
            liveModels = [
                {
                    id: 'gemini-3.8-live',
                    name: 'Gemini 3.8 Flash Live',
                    description: '最新・音声リアルタイム対話 / 推奨',
                    isLiveOptimized: true
                },
                {
                    id: 'gemini-3.8-live-extended-thinking',
                    name: 'Gemini 3.8 Flash Live (Extended Thinking)',
                    description: '深層推論対応 Live 対話モデル',
                    isLiveOptimized: true
                }
            ];
            await db.setSetting('GEMINI_LIVE_AVAILABLE_MODELS', JSON.stringify(liveModels));
            if (!await db.getSetting('GEMINI_LIVE_DEFAULT_MODEL')) {
                await db.setSetting('GEMINI_LIVE_DEFAULT_MODEL', 'gemini-3.8-live');
            }
        }

        // 返却用のフォーマット保証
        const formattedModels = liveModels.map(m => ({
            id: m.id,
            name: m.name || m.id,
            displayName: m.displayName || m.name || m.id,
            description: m.description || '',
            isLiveOptimized: true
        }));

        res.json({
            models: formattedModels,
            currentModel: currentSavedModel || defaultModel,
            defaultModel: defaultModel,
            isConfigured: !!apiKey,
            warning: apiKey ? null : 'Gemini APIキーが設定されていません。システム設定画面でAPIキーを登録してください。'
        });
    } catch (err) {
        console.error('[Gemini Live API] Failed to fetch live models from DB:', err);
        res.status(500).json({ error: 'Failed to fetch Live models' });
    }
});

/**
 * REST API: Liveチャット専用の設定取得 (他機能の GEMINI_MODEL には一切干渉しない)
 */
router.get('/settings', async (req, res) => {
    try {
        const liveModel = await db.getSetting('GEMINI_LIVE_MODEL') || await db.getSetting('GEMINI_MODEL') || '';
        res.json({
            currentModel: liveModel
        });
    } catch (err) {
        console.error('[Gemini Live API] Failed to fetch settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * REST API: Liveチャット専用のモデル保存 (他機能の GEMINI_MODEL には一切干渉しない)
 */
router.post('/settings', async (req, res) => {
    try {
        const { model } = req.body;
        if (!model || typeof model !== 'string') {
            return res.status(400).json({ error: 'Model name is required' });
        }
        const cleanModel = model.replace(/^models\//, '').trim();
        await db.setSetting('GEMINI_LIVE_MODEL', cleanModel);
        console.log(`[Gemini Live API] Saved dedicated live model: ${cleanModel} (GEMINI_MODEL unchanged)`);
        res.json({ success: true, model: cleanModel });
    } catch (err) {
        console.error('[Gemini Live API] Failed to save settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * REST API: Live Concierge が参照可能なナレッジ記事一覧の取得
 */
router.get('/knowledge/list', async (req, res) => {
    try {
        const list = await listRecentArticles(100, req.user);
        res.json({ articles: list });
    } catch (err) {
        console.error('[Gemini Live API] Failed to list knowledge articles:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * REST API: 指定したナレッジ記事のセマンティック抽出サマリーと全文コンテキストの取得
 */
router.get('/knowledge/:id', async (req, res) => {
    try {
        const article = await fetchArticleById(req.params.id, req.user);
        if (!article) {
            return res.status(404).json({ error: '指定されたナレッジ記事が見つからないか、アクセス権限がありません。' });
        }
        const extracted = extractKnowledgeContext(article);
        res.json(extracted);
    } catch (err) {
        console.error('[Gemini Live API] Failed to get knowledge article:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Gemini Live API に登録するナレッジ参照 & 検索ツール定義 (Function Calling)
 */
const KNOWLEDGE_LIVE_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'get_knowledge_article',
                description: 'ナレッジデータベースから指定した記事IDのタイトル、タグ、要約、主要な分析データ、KPI、グラフ内訳などの詳細を取得します。',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        id: { type: 'INTEGER', description: '取得したいナレッジ記事のID番号' }
                    },
                    required: ['id']
                }
            },
            {
                name: 'search_knowledge_articles',
                description: 'ナレッジデータベースからキーワードやタグに関連する分析レポートやナレッジ記事を検索し、一覧を取得します。',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        query: { type: 'STRING', description: '検索キーワード（例: NPB、行政手続、MCP、競合調査、売上推移など）' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'list_recent_knowledge',
                description: '最近保存された DeepResearch や AI MCP Analytics の最新ナレッジ記事一覧（タイトル、タグ、作成日時）を取得します。',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        limit: { type: 'INTEGER', description: '取得件数（デフォルト: 5）' }
                    }
                }
            }
        ]
    }
];

/**
 * Gemini 3.8 Multimodal Live API WebSocket プロキシのセットアップ
 * @param {import('http').Server} server 
 */
function setupGeminiLiveWebSocket(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
        const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;

        if (pathname === '/ws/gemini-live') {
            console.log('[Gemini Live WS] Upgrade request received on /ws/gemini-live');

            // ZTA 認証チェック
            const user = await authenticateRequest(request);
            if (!user) {
                console.warn('[Gemini Live WS] Authentication failed. Rejecting WebSocket handshake.');
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request, user);
            });
        }
    });

    wss.on('connection', async (clientWs, request, user) => {
        console.log(`[Gemini Live WS] Client connected: user=${user.email} (${user.id})`);

        // 1. API キーを DB または環境変数から安全に取得 (ハードコード禁止)
        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('[Gemini Live WS] Gemini API Key is not configured.');
            clientWs.send(JSON.stringify({
                type: 'error',
                message: '⚠️ Live Concierge（リアルタイム音声・画面対話）は Google Gemini 専用機能です。利用するには System Settings で Gemini API Key を設定してください。'
            }));
            clientWs.close(1008, 'API Key missing');
            return;
        }

        // 2. Liveチャット専用のモデル名を動的に取得 (GEMINI_LIVE_MODEL を最優先、未設定時は GEMINI_MODEL を参照)
        const dbLiveModel = await db.getSetting('GEMINI_LIVE_MODEL');
        const dbFallbackModel = await db.getSetting('GEMINI_MODEL');
        let liveModel = dbLiveModel || dbFallbackModel;
        if (!liveModel) {
            liveModel = 'gemini-3.8-live'; // 最終セーフティフォールバック
        }
        if (liveModel.startsWith('models/')) {
            liveModel = liveModel.replace('models/', '');
        }
        // REST用 gemini-3.8-flash が選択された場合は Live API 公式の gemini-3.8-live へ自動解決
        if (liveModel === 'gemini-3.8-flash' || liveModel === 'gemini-3.8-flash-exp') {
            liveModel = 'gemini-3.8-live';
        }

        console.log(`[Gemini Live WS] Connecting upstream to Google Multimodal Live API (dedicated live model: ${liveModel})...`);

        const upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        let upstreamWs = null;
        let isUpstreamOpen = false;
        let isSetupSent = false;
        let currentConnectedModel = null;
        let currentConnectedVoice = null;
        let currentKnowledgeContext = null;
        let selectedVoice = 'Puck';
        const pendingClientQueue = [];

        const createSetupMessage = (modelName, voiceName, customPrompt, initialKnowledge) => {
            let systemPrompt = customPrompt || 
                `あなたはEmployee Agent（WebOSデスクトップ環境）の専属AIコンシェルジュ「Employee Agent Live」です。
ユーザーが画面に表示しているダッシュボードやリアルタイム映像を見ながら、親切、簡潔、フレンドリーな日本語音声で対話してください。
【あなたの役割】
1. 画面と同期した操作ナビゲーション解説（最重要）:
   ダッシュボード（NPB分析レポート等）に複数の切り替えタブがある場合は、ユーザーが今見ている画面と解説が常に一致するよう、「まず最初に表示されている『〇〇』タブをご覧ください」「続いて、画面上部の『△△』タブをクリックして開いてご覧ください」のように、具体的なタブ名やボタンの操作を丁寧に案内しながら解説を進めてください。
   また、ユーザーがダッシュボード上のタブを切り替えた通知を受け取った場合は、その新しく開かれたタブの内容に合わせて解説を行ってください。
2. ナレッジ・AI Analytics解説:
   画面にダッシュボードやグラフ（Chart.js、SVG、テーブル）、または読み込まれたナレッジレポートが表示されている場合、各チャートのトレンドや順位、注目すべきKPI・成績の意味を分かりやすく解説してください。
3. FAQ対応 & ツール活用:
   レポート内容に関する質問には的確に回答し、必要に応じてナレッジ取得ツール（get_knowledge_article, search_knowledge_articles等）を活用して詳細データを参照してください。
4. 全二重対話 (Barge-in対応):
   音声対話のため、1回の発話は2〜4文程度で端的に返し、ユーザーがタブを切り替えたり質問したりする間を設けながらテンポよく会話を進めてください。ユーザーが途中で割り込んできた場合、即座にその質問に応答してください。`;

            if (initialKnowledge && initialKnowledge.formattedContext) {
                const tabHint = (initialKnowledge.uiTabs && initialKnowledge.uiTabs.length > 0)
                    ? `なお、このダッシュボードには「${initialKnowledge.uiTabs.join('」「')}」のタブがあります。まずは初期表示されている「${initialKnowledge.uiTabs[0]}」タブの見どころから案内し、他のタブについては「画面上部の『〇〇』タブを開いてご覧ください」と操作を促しながら解説してください。`
                    : '';
                systemPrompt += `\n\n【現在開いているナレッジレポート】\n${initialKnowledge.formattedContext}\n\n※ユーザーと会話を開始する際は、「『${initialKnowledge.title}』のダッシュボード画面を表示しました。概要を順番に解説しますが、質問や気になるタブがあればいつでもお声がけください」と音声で伝えた上で、続けてこのレポートの要約・重要ポイントを簡潔に話し始めてください。${tabHint}`;
            }

            const isExtendedThinking = modelName.includes('extended-thinking') || modelName.includes('thinking');

            const generationConfig = {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voiceName || "Puck"
                        }
                    }
                }
            };

            // Extended Thinking モデル必須要件: thinkingLevel (Google Live API 仕様)
            if (isExtendedThinking) {
                generationConfig.thinkingConfig = {
                    thinkingLevel: "low"
                };
            }

            return {
                setup: {
                    model: `models/${modelName}`,
                    generationConfig,
                    systemInstruction: {
                        parts: [{ text: systemPrompt }]
                    },
                    tools: KNOWLEDGE_LIVE_TOOLS,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {}
                }
            };
        };

        // Google Live API との接続確立・切替 (Google仕様上 setup は接続直後に1度しか送信できないため)
        const connectOrSwitchUpstream = (targetModel, targetVoice, customPrompt, initialKnowledge) => {
            // 既に同じモデル・声質で接続済みの場合は setup を再送せず維持
            if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && 
                currentConnectedModel === targetModel && currentConnectedVoice === targetVoice) {
                console.log(`[Gemini Live WS] Upstream already connected with model=${targetModel}, voice=${targetVoice}. Keeping session.`);
                return;
            }

            // 以前の Upstream があれば安全に切断
            if (upstreamWs) {
                console.log(`[Gemini Live WS] Closing previous upstream (was model=${currentConnectedModel}, new model=${targetModel})...`);
                try {
                    upstreamWs.removeAllListeners();
                    upstreamWs.close();
                } catch (_) {}
                upstreamWs = null;
            }

            isUpstreamOpen = false;
            isSetupSent = false;
            currentConnectedModel = targetModel;
            currentConnectedVoice = targetVoice;

            console.log(`[Gemini Live WS] Connecting upstream to Google Multimodal Live API (model: ${targetModel}, voice: ${targetVoice})...`);

            try {
                upstreamWs = new WebSocket(upstreamUrl);
            } catch (err) {
                console.error('[Gemini Live WS] Failed to create upstream WebSocket:', err);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'error', message: 'Google Live API への接続初期化に失敗しました。' }));
                }
                return;
            }

            upstreamWs.on('open', () => {
                console.log(`[Gemini Live WS] Connected to Google Multimodal Live API (model: ${targetModel}) successfully.`);
                isUpstreamOpen = true;

                // 最初の一手として setup メッセージを単一送信 (重複送信厳禁)
                const setupMsg = createSetupMessage(targetModel, targetVoice, customPrompt, initialKnowledge || currentKnowledgeContext);
                upstreamWs.send(JSON.stringify(setupMsg));
                isSetupSent = true;
                console.log(`[Gemini Live WS] Sent initial setup message with Knowledge Tools: model=${targetModel}, voice=${targetVoice}`);

                // 保留キューの中身をフラッシュ
                while (pendingClientQueue.length > 0) {
                    const queued = pendingClientQueue.shift();
                    upstreamWs.send(queued);
                }

                // クライアントへ接続完了を通知
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'ready',
                        model: targetModel,
                        message: `Gemini Live API (${targetModel}) に接続しました。画面共有および音声の送信を開始できます。`
                    }));
                }
            });

            // Google からのレスポンスをクライアントへ転送 & toolCall の自律処理
            upstreamWs.on('message', async (data) => {
                try {
                    const text = data.toString();
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch (_) {}

                    // 1. Google Live API からの toolCall (Function Calling) インターセプト
                    if (parsed && parsed.toolCall && Array.isArray(parsed.toolCall.functionCalls)) {
                        console.log('[Gemini Live WS] toolCall received from upstream:', parsed.toolCall.functionCalls.map(f => f.name));

                        // クライアントへツール実行中を通知 (UI用)
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'tool_execution',
                                functionCalls: parsed.toolCall.functionCalls
                            }));
                        }

                        // 各ツールの実行
                        const functionResponses = await Promise.all(parsed.toolCall.functionCalls.map(async (fc) => {
                            let output = {};
                            try {
                                if (fc.name === 'get_knowledge_article') {
                                    const art = await fetchArticleById(fc.args.id, user);
                                    output = art ? extractKnowledgeContext(art) : { error: '記事が見つかりません。' };
                                } else if (fc.name === 'search_knowledge_articles') {
                                    const results = await searchArticles(fc.args.query, user);
                                    output = { results };
                                } else if (fc.name === 'list_recent_knowledge') {
                                    const articles = await listRecentArticles(fc.args.limit || 5, user);
                                    output = { articles };
                                } else {
                                    output = { error: `未対応のツール呼び出しです: ${fc.name}` };
                                }
                            } catch (toolErr) {
                                console.error(`[Gemini Live WS] Error executing tool ${fc.name}:`, toolErr);
                                output = { error: toolErr.message };
                            }

                            return {
                                id: fc.id,
                                name: fc.name,
                                response: { output }
                            };
                        }));

                        // Google Upstream へ toolResponse を返送
                        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                            console.log('[Gemini Live WS] Sending toolResponse back upstream...');
                            upstreamWs.send(JSON.stringify({
                                toolResponse: { functionResponses }
                            }));
                        }
                    }

                    // 2. 通常のメッセージ転送
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(text);
                    }
                } catch (err) {
                    console.error('[Gemini Live WS] Error forwarding upstream message to client:', err);
                }
            });

            upstreamWs.on('error', (err) => {
                console.error('[Gemini Live WS] Upstream Google WebSocket error:', err.message || err);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'error',
                        message: `Google Live API エラー: ${err.message || '接続に問題が発生しました'}`
                    }));
                }
            });

            upstreamWs.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                console.log(`[Gemini Live WS] Upstream Google WebSocket closed: code=${code}, reason=${reasonStr}`);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'error',
                        message: `Google Live API 切断 (code: ${code}): ${reasonStr || '接続が切断されました'}`
                    }));
                }
            });
        };

        // クライアントからの最初のメッセージ待機（500ms 内に init_session が来ない場合はデフォルトで接続）
        const autoConnectTimer = setTimeout(() => {
            if (!upstreamWs) {
                console.log(`[Gemini Live WS] autoConnectTimer fired, connecting with defaults (model=${liveModel}, voice=${selectedVoice})...`);
                connectOrSwitchUpstream(liveModel, selectedVoice);
            }
        }, 300);

        // クライアント（ブラウザ）からのメッセージ処理
        clientWs.on('message', async (message) => {
            try {
                let payload = message.toString();
                const parsed = JSON.parse(payload);

                // カスタムアクション: セッション初期化・モデル切り替え
                if (parsed.type === 'init_session') {
                    clearTimeout(autoConnectTimer);

                    if (parsed.model && typeof parsed.model === 'string') {
                        let reqModel = parsed.model.replace(/^models\//, '').trim();
                        if (reqModel === 'gemini-3.8-flash' || reqModel === 'gemini-3.8-flash-exp') {
                            reqModel = 'gemini-3.8-live';
                        }
                        liveModel = reqModel;
                        await db.setSetting('GEMINI_LIVE_MODEL', liveModel);
                        console.log(`[Gemini Live WS] Updated dedicated live model via init_session: ${liveModel}`);
                    }
                    if (parsed.voiceName) {
                        selectedVoice = parsed.voiceName;
                    }

                    // 初期ナレッジIDが指定されていた場合、ロードしてコンテキスト化
                    if (parsed.initialKnowledgeId) {
                        const art = await fetchArticleById(parsed.initialKnowledgeId, user);
                        if (art) {
                            currentKnowledgeContext = extractKnowledgeContext(art);
                            console.log(`[Gemini Live WS] Loaded initial knowledge: ${currentKnowledgeContext.title} (#${currentKnowledgeContext.id})`);
                            if (clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({
                                    type: 'knowledge_loaded',
                                    knowledge: {
                                        id: currentKnowledgeContext.id,
                                        title: currentKnowledgeContext.title,
                                        tags: currentKnowledgeContext.tags,
                                        created_at: currentKnowledgeContext.created_at,
                                        rawHtml: currentKnowledgeContext.rawHtml,
                                        rawContent: currentKnowledgeContext.rawContent,
                                        uiTabs: currentKnowledgeContext.uiTabs
                                    }
                                }));
                            }
                        }
                    } else if (parsed.initialRawHtml) {
                        // MCPチャット画面等から直接HTML/SVGダッシュボードが渡された場合
                        currentKnowledgeContext = extractKnowledgeContext({
                            id: null,
                            title: parsed.initialKnowledgeTitle || 'AI Analytics ダッシュボード',
                            content: parsed.initialRawHtml,
                            tags: ['MCP Direct', 'Dashboard']
                        });
                        console.log(`[Gemini Live WS] Loaded initial raw HTML dashboard: ${currentKnowledgeContext.title}`);
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'knowledge_loaded',
                                knowledge: {
                                    id: null,
                                    title: currentKnowledgeContext.title,
                                    tags: currentKnowledgeContext.tags,
                                    rawHtml: currentKnowledgeContext.rawHtml || parsed.initialRawHtml,
                                    rawContent: parsed.initialRawHtml,
                                    uiTabs: currentKnowledgeContext.uiTabs
                                }
                            }));
                        }
                    }

                    // 指定されたモデルと声質で Upstream を確立/切替
                    connectOrSwitchUpstream(liveModel, selectedVoice, parsed.systemInstruction, currentKnowledgeContext);
                    return;
                }

                // カスタムアクション: ナレッジ記事の動的ロード・切り替え
                if (parsed.type === 'load_knowledge') {
                    const articleId = parsed.knowledgeId;
                    const isSwitch = !!parsed.isSwitch;

                    if (!articleId) {
                        currentKnowledgeContext = null;
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'knowledge_unloaded' }));
                        }
                        return;
                    }

                    const article = await fetchArticleById(articleId, user);
                    if (!article) {
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'error', message: '指定されたナレッジ記事が見つかりません。' }));
                        }
                        return;
                    }

                    const extracted = extractKnowledgeContext(article);
                    currentKnowledgeContext = extracted;
                    console.log(`[Gemini Live WS] Knowledge loaded via load_knowledge: ${extracted.title} (isSwitch: ${isSwitch}, tabs: ${(extracted.uiTabs || []).length})`);

                    const tabNavGuide = (extracted.uiTabs && extracted.uiTabs.length > 0)
                        ? `\n\n【重要：画面と解説の同期ナビゲーション指示】\n画面のダッシュボードには「${extracted.uiTabs.join('」「')}」のタブがあります。現在は最初の「${extracted.uiTabs[0]}」タブがユーザーの画面に表示されています。まずは「現在は『${extracted.uiTabs[0]}』タブが表示されています」と伝えてその内容を解説し、別のタブのデータに触れる際は必ず「続いて画面上部の『〇〇』タブをクリックして開いてご覧ください」とユーザーの画面操作を丁寧に案内してください。`
                        : '';

                    // Upstream が接続中の場合、clientContent を送信して AI に音声発話をキック
                    if (isSetupSent && isUpstreamOpen && upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                        const promptText = isSwitch
                            ? `[システム通知: 画面が切り替わりました。ユーザーの画面に新しいダッシュボード『${extracted.title}』が表示されました。ユーザーに「画面が切り替わりました。『${extracted.title}』のダッシュボード画面を表示しました。概要を順番に解説しますが、質問があればいつでもどうぞ」と音声で伝えた上で、続けてこのレポートの要約・主要な発見を画面のタブ構成に沿って簡潔に説明してください。${tabNavGuide}\n\n【新レポート内容】\n${extracted.formattedContext}]`
                            : `[システム通知: ユーザーの画面にナレッジダッシュボード『${extracted.title}』が表示されました。ユーザーに「『${extracted.title}』のダッシュボード画面を表示しました。概要を順番に解説しますが、質問があればいつでもどうぞ」と音声で伝えた上で、続けてこのレポートの要約・主要な発見を画面のタブ構成に沿って簡潔に説明してください。${tabNavGuide}\n\n【レポート内容】\n${extracted.formattedContext}]`;

                        console.log('[Gemini Live WS] Committing knowledge turn to Gemini Live...');
                        upstreamWs.send(JSON.stringify({
                            clientContent: {
                                turns: [
                                    {
                                        role: 'user',
                                        parts: [{ text: promptText }]
                                    }
                                ],
                                turnComplete: true
                            }
                        }));
                    }

                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'knowledge_loaded',
                            knowledge: {
                                id: extracted.id,
                                title: extracted.title,
                                tags: extracted.tags,
                                created_at: extracted.created_at,
                                rawHtml: extracted.rawHtml,
                                rawContent: extracted.rawContent,
                                uiTabs: extracted.uiTabs
                            }
                        }));
                    }
                    return;
                }

                // カスタムアクション: MCPチャット等から直接渡された生HTMLダッシュボードの動的ロード
                if (parsed.type === 'load_raw_html' && parsed.rawHtml) {
                    const extracted = extractKnowledgeContext({
                        id: null,
                        title: parsed.title || 'AI Analytics ダッシュボード',
                        content: parsed.rawHtml,
                        tags: ['MCP Direct', 'Dashboard']
                    });
                    currentKnowledgeContext = extracted;
                    const tabNavGuide = (extracted.uiTabs && extracted.uiTabs.length > 0)
                        ? `\n\n【重要：画面と解説の同期ナビゲーション指示】\n画面のダッシュボードには「${extracted.uiTabs.join('」「')}」のタブがあります。現在は最初の「${extracted.uiTabs[0]}」タブがユーザーの画面に表示されています。まずは「現在は『${extracted.uiTabs[0]}』タブが表示されています」と伝えてその内容を解説し、別のタブのデータに触れる際は必ず「続いて画面上部の『〇〇』タブをクリックして開いてご覧ください」とユーザーの画面操作を丁寧に案内してください。`
                        : '';

                    if (isSetupSent && isUpstreamOpen && upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                        const promptText = `[システム通知: ユーザーはMCPチャットから『${extracted.title}』のダッシュボード画面を開きました。ユーザーに「『${extracted.title}』のダッシュボードを読み込みました。画面に沿って順番に解説します」と音声で伝えた上で、タブ構成と主要なデータを簡潔に解説してください。${tabNavGuide}\n\n【ダッシュボード内容】\n${extracted.formattedContext}]`;
                        upstreamWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{ role: 'user', parts: [{ text: promptText }] }],
                                turnComplete: true
                            }
                        }));
                    }

                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'knowledge_loaded',
                            knowledge: {
                                id: null,
                                title: extracted.title,
                                tags: extracted.tags,
                                rawHtml: extracted.rawHtml || parsed.rawHtml,
                                rawContent: parsed.rawHtml,
                                uiTabs: extracted.uiTabs
                            }
                        }));
                    }
                    return;
                }

                // カスタムアクション: ユーザーがダッシュボード内のタブをクリックして切り替えた際の同期通知
                if (parsed.type === 'user_tab_changed' && parsed.tabName) {
                    console.log(`[Gemini Live WS] User clicked dashboard tab: ${parsed.tabName}`);
                    if (isSetupSent && isUpstreamOpen && upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                        const tabPrompt = `[システム通知: ユーザーがダッシュボード画面上の「${parsed.tabName}」タブをクリックして開きました。現在ユーザーが見ている「${parsed.tabName}」タブに表示されているグラフや数値データの見どころ・ポイントを簡潔に音声で解説してください。]`;
                        upstreamWs.send(JSON.stringify({
                            clientContent: {
                                turns: [{ role: 'user', parts: [{ text: tabPrompt }] }],
                                turnComplete: true
                            }
                        }));
                    }
                    return;
                }

                // Upstream がまだ初期化されていない場合は初期化
                if (!upstreamWs) {
                    clearTimeout(autoConnectTimer);
                    connectOrSwitchUpstream(liveModel, selectedVoice);
                }

                if (isSetupSent && isUpstreamOpen && upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                    upstreamWs.send(payload);
                } else {
                    pendingClientQueue.push(payload);
                }
            } catch (err) {
                console.error('[Gemini Live WS] Error forwarding client message upstream:', err);
            }
        });

        clientWs.on('close', () => {
            clearTimeout(autoConnectTimer);
            console.log(`[Gemini Live WS] Client disconnected: ${user.email}`);
            if (upstreamWs) {
                try {
                    upstreamWs.removeAllListeners();
                    upstreamWs.close();
                } catch (_) {}
                upstreamWs = null;
            }
        });

        clientWs.on('error', (err) => {
            clearTimeout(autoConnectTimer);
            console.error('[Gemini Live WS] Client WebSocket error:', err);
            if (upstreamWs) {
                try {
                    upstreamWs.removeAllListeners();
                    upstreamWs.close();
                } catch (_) {}
                upstreamWs = null;
            }
        });
    });

    console.log('[Gemini Live WS] WebSocket proxy initialized on /ws/gemini-live');
}

module.exports = { setupGeminiLiveWebSocket, router };
