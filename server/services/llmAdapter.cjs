const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');

// Node.js 24 (OpenSSL 3.5) + Docker bridge MTU compatibility:
// Prevent oversized Post-Quantum X25519MLKEM768 TLS ClientHello ECONNRESET on api.anthropic.com
tls.DEFAULT_ECDH_CURVE = 'X25519:P-256:P-384';

/**
 * macOS VPN (utun MTU 1000) + Docker Desktop (eth0 MTU 65535) 対策用の安全な HTTPS リクエスト関数
 * TLS ハンドシェイク完了後にリクエストボディを 800 バイト単位で分割送信し、TCP/TLS フラグメンテーションによる ECONNRESET を完全に回避する
 */
function anthropicHttpsRequest(urlPath, { method = 'GET', headers = {}, body = null, timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
        const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')) : null;
        const reqHeaders = {
            ...headers,
            'connection': 'close'
        };
        if (bodyBuf) {
            reqHeaders['content-length'] = bodyBuf.length;
        }

        const req = https.request({
            hostname: 'api.anthropic.com',
            servername: 'api.anthropic.com',
            family: 4,
            port: 443,
            path: urlPath,
            method,
            agent: false,
            ecdhCurve: 'X25519:P-256:P-384',
            headers: reqHeaders,
            timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const rawText = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: async () => rawText,
                    json: async () => JSON.parse(rawText || '{}')
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('Anthropic API request timed out'));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (!bodyBuf || bodyBuf.length === 0) {
            req.end();
            return;
        }

        let bodySent = false;
        const sendChunkedBody = async () => {
            if (bodySent) return;
            bodySent = true;
            try {
                req.flushHeaders();
                await new Promise(r => setTimeout(r, 25));
                const CHUNK_SIZE = 512; // utun MTU 1000 未満に確実に収まる安全な TLS レコードサイズ
                for (let offset = 0; offset < bodyBuf.length; offset += CHUNK_SIZE) {
                    if (req.destroyed) return;
                    const slice = bodyBuf.subarray(offset, offset + CHUNK_SIZE);
                    const canContinue = req.write(slice);
                    if (!canContinue) {
                        await new Promise(r => req.once('drain', r));
                    }
                    if (offset + CHUNK_SIZE < bodyBuf.length) {
                        await new Promise(r => setTimeout(r, 10));
                    }
                }
                if (!req.destroyed) {
                    req.end();
                }
            } catch (writeErr) {
                reject(writeErr);
            }
        };

        req.on('socket', (socket) => {
            socket.setNoDelay(true);
            if (socket.encrypted && !socket.connecting) {
                sendChunkedBody();
            } else {
                socket.once('secureConnect', sendChunkedBody);
            }
        });
    });
}

let AnthropicSDK = null;
try {
    AnthropicSDK = require('@anthropic-ai/sdk');
    if (AnthropicSDK && AnthropicSDK.default) {
        AnthropicSDK = AnthropicSDK.default;
    }
} catch (e) {
    console.warn('[LLM Adapter] @anthropic-ai/sdk not loaded, falling back to native fetch for Anthropic API.');
}

// 初期シード用 Claude モデル一覧 (DBの CLAUDE_AVAILABLE_MODELS が空の場合のみ初期値として利用)
const INITIAL_CLAUDE_MODELS = [
    {
        name: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5 (推奨・バランス型)',
        description: 'Anthropic 最新・高速かつ高精度なフラッグシップモデル',
        provider: 'claude',
        inputTokenLimit: 200000,
        outputTokenLimit: 16384
    },
    {
        name: 'claude-opus-4-5',
        displayName: 'Claude Opus 4.5 (最高峰推論・Deep Research向)',
        description: '複雑な分析・長文レポート・高度なコーディング向け最上位モデル',
        provider: 'claude',
        inputTokenLimit: 200000,
        outputTokenLimit: 16384
    },
    {
        name: 'claude-3-7-sonnet-latest',
        displayName: 'Claude 3.7 Sonnet (Extended Thinking対応)',
        description: 'ハイブリッド推論・ダッシュボード/HTML生成・MCPツール実行に最適',
        provider: 'claude',
        inputTokenLimit: 200000,
        outputTokenLimit: 16384
    },
    {
        name: 'claude-3-5-sonnet-latest',
        displayName: 'Claude 3.5 Sonnet',
        description: '安定版 Sonnet モデル',
        provider: 'claude',
        inputTokenLimit: 200000,
        outputTokenLimit: 8192
    },
    {
        name: 'claude-3-5-haiku-latest',
        displayName: 'Claude 3.5 Haiku (高速・軽量)',
        description: '日常チャット・タグ抽出・高速応答向け軽量モデル',
        provider: 'claude',
        inputTokenLimit: 200000,
        outputTokenLimit: 8192
    }
];

// メモリキャッシュ (Claude MCP マルチターン履歴保持用: interactionId -> messages[])
const claudeConversations = new Map();

/**
 * 指定されたモデル名が Claude (Anthropic) モデルかどうかを判定
 * 次世代モデル系列 (claude-fable-*, fable-* 等) も含めて判定
 */
function isClaudeModel(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;
    const clean = modelName.replace(/^models\//, '').trim().toLowerCase();
    return clean.startsWith('claude-') || clean.startsWith('fable-');
}

/**
 * ZTA PDP (allowed_models) に基づき、ユーザーが指定モデルを利用可能か動的判定する共通ヘルパー
 * 特定バージョン文字列のハードコードを避け、ファミリー/ティア単位 (Flash, Pro/Argon/Carbon, Sonnet/Haiku, Opus/Fable) で評価する
 */
function isModelAllowedForUser(requestedModel, allowedModels = [], systemDefaultModels = []) {
    if (!requestedModel || typeof requestedModel !== 'string') return true;
    if (!Array.isArray(allowedModels) || allowedModels.length === 0) return false;
    if (allowedModels.includes('*')) return true;

    const clean = requestedModel.replace(/^models\//, '').trim().toLowerCase();
    const cleanDefaults = systemDefaultModels
        .filter(Boolean)
        .map(m => String(m).replace(/^models\//, '').trim().toLowerCase());

    // 直接指定 (model:<id>) の一致
    if (allowedModels.includes(`model:${requestedModel}`) || allowedModels.includes(`model:${clean}`)) {
        return true;
    }

    // システム標準デフォルトモデル (Adminが設定した GEMINI_MODEL / GEMINI_MCP_CHAT_MODEL 等) は基本ロール権限で許可
    if (cleanDefaults.includes(clean) && (allowedModels.includes('model:gemini-flash') || allowedModels.includes('model:claude-sonnet'))) {
        return true;
    }

    // 1. Gemini Flash / 軽量系 (3.8 Flash, 4 Flash, Gemma 等)
    if (allowedModels.includes('model:gemini-flash') && (clean.includes('flash') || clean.includes('gemma'))) {
        return true;
    }
    // 2. Gemini Pro / 次世代上位推論系 (Pro, Gemini 4 Argon, Gemini 4 Carbon, Ultra 等)
    if (allowedModels.includes('model:gemini-pro') && (
        clean.includes('pro') ||
        clean.includes('argon') ||
        clean.includes('carbon') ||
        clean.includes('ultra')
    )) {
        return true;
    }
    // 3. Claude Haiku / 軽量系
    if (allowedModels.includes('model:claude-haiku') && clean.includes('haiku')) {
        return true;
    }
    // 4. Claude Sonnet / 標準分析系
    if (allowedModels.includes('model:claude-sonnet') && (clean.includes('sonnet') || clean.includes('haiku'))) {
        return true;
    }
    // 5. Claude Opus / Fable 次世代フラッグシップ系 (Opus 5.5, Fable 5.5 等)
    if ((allowedModels.includes('model:claude-opus') || allowedModels.includes('model:claude-fable')) && (
        clean.includes('opus') ||
        clean.includes('fable')
    )) {
        return true;
    }
    // 6. 画像・図解生成系 (Nano Banana / Imagen / Flash Image)
    if (allowedModels.includes('model:nano-banana') && (
        clean.includes('image') ||
        clean.includes('imagen') ||
        clean.includes('banana')
    )) {
        return true;
    }

    return false;
}

/**
 * モデル名から 'models/' プレフィックスを除去
 */
function cleanModelId(modelName, fallback = '') {
    if (!modelName || typeof modelName !== 'string') return fallback;
    return modelName.replace(/^models\//, '').trim() || fallback;
}

/**
 * DB設定および環境変数から現在のプロバイダー設定を解決
 * (ハードコード禁止原則に準拠し、すべてDB設定から動的に取得)
 */
async function resolveActiveConfig(db) {
    const aiProvider = (await db.getSetting('AI_PROVIDER')) || process.env.AI_PROVIDER || 'gemini';
    const geminiApiKey = (await db.getSetting('GEMINI_API_KEY')) || process.env.GEMINI_API_KEY || '';
    const claudeApiKey = (await db.getSetting('CLAUDE_API_KEY')) || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';

    const geminiModel = (await db.getSetting('GEMINI_MODEL')) || process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
    const claudeModel = (await db.getSetting('CLAUDE_MODEL')) || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

    const geminiResearchModel = (await db.getSetting('GEMINI_RESEARCH_MODEL')) || 'deep-research-pro-preview-12-2025';
    const claudeResearchModel = (await db.getSetting('CLAUDE_RESEARCH_MODEL')) || claudeModel;

    const geminiHtmlSvgModel = (await db.getSetting('GEMINI_HTML_SVG_MODEL')) || geminiModel;
    const claudeHtmlSvgModel = (await db.getSetting('CLAUDE_HTML_SVG_MODEL')) || claudeModel;

    const geminiMcpChatModel = (await db.getSetting('MCP_CHAT_MODEL')) || 'gemini-2.5-pro';
    const claudeMcpChatModel = (await db.getSetting('CLAUDE_MCP_CHAT_MODEL')) || claudeModel;

    return {
        aiProvider,
        geminiApiKey,
        claudeApiKey,
        isGeminiConfigured: !!geminiApiKey,
        isClaudeConfigured: !!claudeApiKey,
        geminiModel,
        claudeModel,
        geminiResearchModel,
        claudeResearchModel,
        geminiHtmlSvgModel,
        claudeHtmlSvgModel,
        geminiMcpChatModel,
        claudeMcpChatModel
    };
}

/**
 * Anthropic API (`GET https://api.anthropic.com/v1/models`) から利用可能な Claude モデル一覧を動的取得
 * APIキーで取得した最新モデル一覧は DB (`CLAUDE_AVAILABLE_MODELS`) にもキャッシュ保存する
 */
async function listClaudeModels(apiKey, db) {
    let cachedModels = [];
    if (db) {
        try {
            const raw = await db.getSetting('CLAUDE_AVAILABLE_MODELS');
            if (raw) {
                cachedModels = JSON.parse(raw);
            }
        } catch (e) {
            console.warn('[LLM Adapter] Failed to parse CLAUDE_AVAILABLE_MODELS:', e.message);
        }
    }

    if (!apiKey) {
        return Array.isArray(cachedModels) && cachedModels.length > 0 ? cachedModels : INITIAL_CLAUDE_MODELS;
    }

    try {
        const response = await anthropicHttpsRequest('/v1/models?limit=100', {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            console.warn(`[LLM Adapter] Anthropic /v1/models returned ${response.status}: ${errText}`);
            return Array.isArray(cachedModels) && cachedModels.length > 0 ? cachedModels : INITIAL_CLAUDE_MODELS;
        }

        const data = await response.json();
        const apiModels = Array.isArray(data.data) ? data.data : [];

        if (apiModels.length === 0) {
            return Array.isArray(cachedModels) && cachedModels.length > 0 ? cachedModels : INITIAL_CLAUDE_MODELS;
        }

        const formatted = apiModels
            .filter(m => m && m.id && isClaudeModel(m.id))
            .map(m => ({
                name: m.id,
                displayName: m.display_name ? `${m.display_name} (${m.id})` : m.id,
                description: `Anthropic Claude Model${m.created_at ? ' - ' + m.created_at.slice(0, 10) : ''}`,
                provider: 'claude',
                inputTokenLimit: 200000,
                outputTokenLimit: 16384
            }));

        // 便利なエイリアス (claude-sonnet-4-5 等) がAPIレスポンスのID一覧に含まれていない場合は先頭に補完
        const existingIds = new Set(formatted.map(m => m.name));
        for (const seed of INITIAL_CLAUDE_MODELS) {
            if (!existingIds.has(seed.name)) {
                formatted.push(seed);
            }
        }

        if (db && formatted.length > 0) {
            try {
                await db.setSetting('CLAUDE_AVAILABLE_MODELS', JSON.stringify(formatted));
            } catch (e) {
                console.warn('[LLM Adapter] Failed to cache CLAUDE_AVAILABLE_MODELS:', e.message);
            }
        }

        return formatted;
    } catch (error) {
        console.error('[LLM Adapter] Error fetching Claude models from Anthropic API:', error.message);
        return Array.isArray(cachedModels) && cachedModels.length > 0 ? cachedModels : INITIAL_CLAUDE_MODELS;
    }
}

/**
 * モデルが temperature パラメータをサポートしていない（非推奨）かどうかを事前判定
 */
function isTemperatureDeprecatedModel(modelName) {
    if (!modelName) return false;
    const m = modelName.toLowerCase();
    return m.includes('opus-5') || m.includes('opus-4') || m.includes('haiku-5') || m.includes('sonnet-5') || m.includes('fable');
}

/**
 * Anthropic Messages API 呼び出しの共通ラッパー
 */
async function callAnthropicMessages(apiKey, payload, betaHeaders = []) {
    const headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
    };
    if (betaHeaders && betaHeaders.length > 0) {
        headers['anthropic-beta'] = betaHeaders.join(',');
    }

    // temperature 非推奨モデルの場合は最初から除外して 400 エラーとレイテンシを未然に防止
    const finalPayload = { ...payload };
    if (isTemperatureDeprecatedModel(finalPayload.model)) {
        delete finalPayload.temperature;
    }

    const doFetch = async (bodyObj) => {
        const MAX_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await anthropicHttpsRequest('/v1/messages', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(bodyObj)
                });
            } catch (netErr) {
                if (attempt < MAX_ATTEMPTS) {
                    console.warn(`[Anthropic API] Network transient error (${netErr.message}), retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
                    await new Promise(r => setTimeout(r, attempt * 1200));
                } else {
                    throw netErr;
                }
            }
        }
    };

    let res = await doFetch(finalPayload);

    let data = await res.json().catch(() => ({}));

    // 万一 API 側から temperature 非推奨エラーが返された場合の自動リカバリー
    if (!res.ok && data?.error?.message && data.error.message.includes('temperature') && 'temperature' in finalPayload) {
        console.warn(`[Anthropic API] ${finalPayload.model}: ${data.error.message} - Retrying without temperature parameter...`);
        delete finalPayload.temperature;
        res = await doFetch(finalPayload);
        data = await res.json().catch(() => ({}));
    }

    // max_tokens がモデル上限を超過している場合の自動ダウングレードリカバリー (例: 16384 -> 8192 -> 4096)
    if (!res.ok && data?.error?.message && data.error.message.includes('max_tokens') && finalPayload.max_tokens > 4096) {
        const matchLimit = data.error.message.match(/maximum.*?(?:is|:)\s*(\d+)/i) || data.error.message.match(/<=\s*(\d+)/);
        const fallbackMax = matchLimit ? parseInt(matchLimit[1], 10) : (finalPayload.max_tokens > 8192 ? 8192 : 4096);
        console.warn(`[Anthropic API] ${finalPayload.model}: ${data.error.message} - Retrying with max_tokens=${fallbackMax}...`);
        finalPayload.max_tokens = fallbackMax;
        res = await doFetch(finalPayload);
        data = await res.json().catch(() => ({}));
    }

    if (!res.ok) {
        const errMsg = data?.error?.message || `Anthropic API Error (${res.status})`;
        throw new Error(errMsg);
    }
    return data;
}

/**
 * Anthropic usage オブジェクトを MacOSUI 標準の usageMetadata 形式に変換
 */
function normalizeClaudeUsage(usage) {
    if (!usage) return null;
    const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const outputTokens = usage.output_tokens || 0;
    return {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0
    };
}

/**
 * レスポンスの content ブロック配列からテキストを抽出
 */
function extractTextFromClaudeContent(contentBlocks) {
    if (!Array.isArray(contentBlocks)) return '';
    return contentBlocks
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
}

/**
 * 単発のテキスト/JSON生成 (Virtual Office 36協定診断、移動時間推定、DM自動返信、タグ抽出、スキルSVGアイコン生成等で使用)
 */
async function generateTextWithClaude({
    apiKey,
    model,
    prompt,
    systemInstruction = '',
    temperature = 0.3,
    maxTokens = 4096,
    jsonMode = false
}) {
    const targetModel = cleanModelId(model, 'claude-sonnet-4-5');
    let sys = systemInstruction || '';
    if (jsonMode) {
        sys = `${sys}\n\nYou must output ONLY valid JSON without any markdown code fences or extra explanation.`.trim();
    }

    const payload = {
        model: targetModel,
        max_tokens: maxTokens,
        temperature,
        messages: [
            { role: 'user', content: prompt }
        ]
    };
    if (sys) {
        payload.system = sys;
    }

    const response = await callAnthropicMessages(apiKey, payload);
    const text = extractTextFromClaudeContent(response.content);
    const usageMetadata = normalizeClaudeUsage(response.usage);

    return {
        text,
        usageMetadata,
        rawResponse: response
    };
}

/**
 * ローカルキャッシュされたRAGファイル群から Claude 用のドキュメント/テキストブロックを構築
 */
function buildClaudeRagContentBlocks(ragFiles = []) {
    const blocks = [];
    const loadedSources = [];

    for (const rf of ragFiles) {
        if (!rf || !rf.local_cache_path) continue;
        try {
            if (!fs.existsSync(rf.local_cache_path)) continue;
            const stat = fs.statSync(rf.local_cache_path);
            // 15MB超のファイルはスキップして安全性を確保
            if (stat.size > 15 * 1024 * 1024) continue;

            const ext = path.extname(rf.local_cache_path).toLowerCase();
            if (ext === '.pdf' || rf.mime_type === 'application/pdf') {
                const base64Data = fs.readFileSync(rf.local_cache_path).toString('base64');
                blocks.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: base64Data
                    },
                    title: rf.file_name || 'Document.pdf'
                });
                loadedSources.push({ name: rf.file_name, type: 'google_drive' });
            } else {
                const textContent = fs.readFileSync(rf.local_cache_path, 'utf8').substring(0, 60000);
                blocks.push({
                    type: 'text',
                    text: `=== 社内RAG参照ドキュメント: ${rf.file_name} ===\n${textContent}\n========================================`
                });
                loadedSources.push({ name: rf.file_name, type: 'google_drive' });
            }
        } catch (err) {
            console.warn(`[LLM Adapter] Failed to read local RAG file ${rf.file_name}:`, err.message);
        }
    }

    // 最後のブロックに Prompt Caching (ephemeral) を付与して長文RAGのコストとレイテンシを削減
    if (blocks.length > 0) {
        blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
    }

    return { blocks, loadedSources };
}

/**
 * Gemini Chat (`POST /api/gemini` -> `processGeminiJob`) の Claude 実行エンジン
 * Normal Chat, Personal RAG, Web Search (Grounding), Deep Research (Chat内), HTML/SVG 生成、Google Drive 保存ツールに対応
 */
async function runClaudeChatJob({
    apiKey,
    model,
    message,
    history = [],
    images = [],
    ragFiles = [],
    systemInstruction = '',
    temperature = 0.7,
    maxOutputTokens = 8192,
    enableWebSearch = false,
    enableDriveSaveTool = false,
    saveToDriveCallback = null
}) {
    const targetModel = cleanModelId(model, 'claude-sonnet-4-5');
    const messages = [];

    // 1. 過去の会話履歴を Anthropic 形式 (`user` / `assistant`) に変換
    if (Array.isArray(history) && history.length > 0) {
        for (const h of history) {
            if (!h || !h.parts || !Array.isArray(h.parts)) continue;
            const role = (h.role === 'model' || h.role === 'assistant') ? 'assistant' : 'user';
            const textParts = h.parts
                .map(p => (typeof p === 'string' ? p : p?.text || ''))
                .filter(Boolean)
                .join('\n')
                .trim();
            if (!textParts) continue;

            // 連続する同一ロールを統合 (Anthropic API 制約対応)
            if (messages.length > 0 && messages[messages.length - 1].role === role) {
                const prevContent = messages[messages.length - 1].content;
                if (typeof prevContent === 'string') {
                    messages[messages.length - 1].content = `${prevContent}\n\n${textParts}`;
                }
            } else {
                messages.push({ role, content: textParts });
            }
        }
    }

    // 先頭が assistant の場合は除去 (Anthropic API は先頭が user 必須)
    while (messages.length > 0 && messages[0].role !== 'user') {
        messages.shift();
    }

    // 2. 今回のユーザーメッセージコンテンツを構築 (RAGドキュメント + 添付画像 + テキスト)
    const userContentBlocks = [];
    const { blocks: ragBlocks, loadedSources } = buildClaudeRagContentBlocks(ragFiles);
    if (ragBlocks.length > 0) {
        userContentBlocks.push(...ragBlocks);
    }

    if (Array.isArray(images) && images.length > 0) {
        for (const img of images) {
            if (!img) continue;
            const base64Data = img.data ? img.data.replace(/^data:image\/\w+;base64,/, '') : '';
            const mediaType = img.mimeType || 'image/png';
            if (base64Data) {
                userContentBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mediaType,
                        data: base64Data
                    }
                });
            }
        }
    }

    userContentBlocks.push({
        type: 'text',
        text: message || 'Hello'
    });

    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        const prev = messages[messages.length - 1].content;
        if (typeof prev === 'string') {
            userContentBlocks.unshift({ type: 'text', text: prev });
        }
        messages[messages.length - 1].content = userContentBlocks;
    } else {
        messages.push({
            role: 'user',
            content: userContentBlocks
        });
    }

    // 3. ツール定義 (Web Search / Google Drive Save)
    const tools = [];
    if (enableWebSearch) {
        tools.push({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5
        });
    }

    if (enableDriveSaveTool && typeof saveToDriveCallback === 'function') {
        tools.push({
            name: 'save_to_drive',
            description: 'Saves the provided text content to a file in the user\'s Google Drive. Use this ONLY when the user explicitly asks to save or export the output to a file or Google Drive.',
            input_schema: {
                type: 'object',
                properties: {
                    filename: {
                        type: 'string',
                        description: 'The name of the file to save (e.g., "report.md", "summary.txt").'
                    },
                    content: {
                        type: 'string',
                        description: 'The full text or markdown content to be written into the file.'
                    }
                },
                required: ['filename', 'content']
            }
        });
    }

    const payload = {
        model: targetModel,
        max_tokens: maxOutputTokens,
        temperature,
        messages
    };

    if (systemInstruction) {
        payload.system = systemInstruction;
    }
    if (tools.length > 0) {
        payload.tools = tools;
    }

    let response;
    try {
        response = await callAnthropicMessages(apiKey, payload, ['prompt-caching-2024-07-31']);
    } catch (err) {
        // もし web_search_20250305 が対象モデルで非対応だった場合はツールなしでリトライ
        if (enableWebSearch && err.message && (err.message.includes('web_search') || err.message.includes('tool'))) {
            console.warn('[LLM Adapter] Retrying Claude call without web_search tool:', err.message);
            payload.tools = tools.filter(t => t.name !== 'web_search');
            if (payload.tools.length === 0) delete payload.tools;
            response = await callAnthropicMessages(apiKey, payload);
        } else {
            throw err;
        }
    }

    let replyText = extractTextFromClaudeContent(response.content);

    // 4. save_to_drive ツール呼び出しのハンドリング
    if (response.stop_reason === 'tool_use' && Array.isArray(response.content) && typeof saveToDriveCallback === 'function') {
        const toolUseBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'save_to_drive');
        if (toolUseBlock && toolUseBlock.input) {
            const { filename, content } = toolUseBlock.input;
            const driveResult = await saveToDriveCallback(filename || 'claude_export.md', content || replyText);
            if (driveResult && driveResult.webViewLink) {
                replyText = `${replyText ? replyText + '\n\n' : ''}✅ Google Driveへの保存が完了しました！\n📄 **[${driveResult.name || filename} を開く](${driveResult.webViewLink})**`;
            }
        }
    }

    return {
        reply: replyText || '回答を生成できませんでした。',
        usageMetadata: normalizeClaudeUsage(response.usage),
        loadedRagSources: loadedSources
    };
}

/**
 * Deep Research バックグラウンドジョブの Claude 実行エンジン
 * Anthropic のビルトイン `web_search_20250305` ツールを最大10回駆使して包括的な調査レポートを合成
 */
async function runClaudeDeepResearchJob({
    jobId,
    apiKey,
    model,
    prompt,
    customInstruction = '',
    researchJobs,
    db
}) {
    const startTime = Date.now();
    const targetModel = cleanModelId(model, 'claude-sonnet-4-5');

    try {
        console.log(`[Claude Deep Research] Starting Job ${jobId} with model: ${targetModel}`);

        const systemPrompt = [
            'あなたは世界最高峰の戦略リサーチャー・アナリストです。',
            'Web検索ツール (web_search) を複数回活用して最新のファクト・統計・一次情報を徹底的に調査し、包括的で構造化された長文の調査レポートを日本語のMarkdown形式で作成してください。',
            'レポートの冒頭には必ず `# タイトル` を記載し、エグゼクティブサマリー、詳細分析、比較データ表（Markdownテーブル）、結論・提言、および参照した情報源（URLリンク）を含めてください。',
            customInstruction || ''
        ].filter(Boolean).join('\n\n');

        const payload = {
            model: targetModel,
            max_tokens: 12000,
            temperature: 0.3,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            tools: [
                {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    max_uses: 10
                }
            ]
        };

        let response;
        try {
            response = await callAnthropicMessages(apiKey, payload);
        } catch (err) {
            if (err.message && (err.message.includes('web_search') || err.message.includes('tool'))) {
                console.warn(`[Claude Deep Research] web_search tool not supported on ${targetModel}, falling back to standard generation:`, err.message);
                delete payload.tools;
                response = await callAnthropicMessages(apiKey, payload);
            } else {
                throw err;
            }
        }

        let finalReport = extractTextFromClaudeContent(response.content);

        // Web検索の引用URLがあれば抽出して末尾に付加
        const citations = [];
        if (Array.isArray(response.content)) {
            for (const block of response.content) {
                if (block.type === 'text' && Array.isArray(block.citations)) {
                    for (const cite of block.citations) {
                        if (cite.url && !citations.some(c => c.url === cite.url)) {
                            citations.push({ title: cite.title || cite.url, url: cite.url });
                        }
                    }
                }
            }
        }

        if (citations.length > 0 && !finalReport.includes('**Sources:**')) {
            finalReport += `\n\n**Sources:**\n` + citations.map(c => `- [${c.title}](${c.url})`).join('\n');
        }

        const durationSec = Math.round((Date.now() - startTime) / 1000);
        const usage = normalizeClaudeUsage(response.usage);
        const inTokens = usage ? usage.promptTokenCount : Math.ceil(prompt.length / 3);
        const outTokens = usage ? usage.candidatesTokenCount : Math.ceil(finalReport.length / 3);

        const summaryMarkdown = `\n\n---\n**Deep Research Usage Summary**\n` +
            `| Metric | Value |\n` +
            `| :--- | :--- |\n` +
            `| **Provider / Model** | Anthropic Claude (\`${targetModel}\`) |\n` +
            `| **Execution Time** | ${Math.floor(durationSec / 60)}m ${durationSec % 60}s |\n` +
            `| **Input Tokens** | ${inTokens.toLocaleString()} tokens |\n` +
            `| **Output Tokens** | ${outTokens.toLocaleString()} tokens |\n` +
            `| **Total Tokens** | ${(inTokens + outTokens).toLocaleString()} tokens |\n`;

        finalReport += summaryMarkdown;

        if (researchJobs && researchJobs[jobId]) {
            researchJobs[jobId].status = 'completed';
            researchJobs[jobId].result = finalReport;
            researchJobs[jobId].usageMetadata = {
                promptTokenCount: inTokens,
                candidatesTokenCount: outTokens,
                totalTokenCount: inTokens + outTokens
            };
        }

        if (db) {
            db.run(
                "UPDATE deep_research_history SET status = 'completed' WHERE query_text = ? AND status = 'in_progress'",
                [prompt]
            );
        }

        console.log(`[Claude Deep Research] Job ${jobId} completed in ${durationSec}s!`);
    } catch (error) {
        console.error(`[Claude Deep Research] Job ${jobId} failed:`, error);
        if (researchJobs && researchJobs[jobId]) {
            researchJobs[jobId].status = 'failed';
            researchJobs[jobId].error = error.message;
        }
        if (db) {
            db.run(
                "UPDATE deep_research_history SET status = 'failed' WHERE query_text = ? AND status = 'in_progress'",
                [prompt]
            );
        }
    }
}

/**
 * MCP ツール定義を Anthropic の `input_schema` フォーマットに変換
 */
function convertMcpToolsToClaudeFormat(mcpTools = []) {
    const claudeTools = [];
    for (const t of mcpTools) {
        if (!t || !t.name) continue;
        const rawSchema = t.parameters || t.inputSchema || { type: 'object', properties: {} };
        claudeTools.push({
            name: t.name,
            description: t.description || `Execute MCP tool ${t.name}`,
            input_schema: {
                type: 'object',
                properties: rawSchema.properties || {},
                required: Array.isArray(rawSchema.required) ? rawSchema.required : []
            }
        });
    }
    return claudeTools;
}

/**
 * MCP Chat (`server/routes/mcpChat.cjs`) の Claude マルチターン自律ツール実行ループ
 */
async function runClaudeMcpWorkflow({
    apiKey,
    model,
    user,
    message,
    previous_interaction_id,
    mcpTools = [],
    callMcpTool,
    systemInstruction = '',
    maxTurns = 15,
    onProgress,
    checkCancelled,
    req
}) {
    const crypto = require('crypto');
    const targetModel = cleanModelId(model, 'claude-sonnet-4-5');
    const claudeTools = convertMcpToolsToClaudeFormat(mcpTools);

    // セッション履歴の復元または新規作成
    let sessionMessages = [];
    if (previous_interaction_id && claudeConversations.has(previous_interaction_id)) {
        sessionMessages = [...claudeConversations.get(previous_interaction_id)];
    }

    sessionMessages.push({
        role: 'user',
        content: message
    });

    const artifacts = [];
    let turnCount = 0;
    let remainingTurns = maxTurns;
    let finalResponseText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (onProgress) {
        onProgress(`Claude (${targetModel}) にリクエストを送信し、実行計画を策定中...`, 0);
    }

    while (remainingTurns > 0) {
        if (checkCancelled && await checkCancelled()) {
            throw new Error('タスクがユーザーによりキャンセルされました');
        }

        remainingTurns--;
        turnCount++;

        const payload = {
            model: targetModel,
            max_tokens: 16384,
            temperature: 0.2,
            system: systemInstruction,
            messages: sessionMessages
        };

        if (claudeTools.length > 0 && remainingTurns > 0) {
            payload.tools = claudeTools;
        }

        const response = await callAnthropicMessages(apiKey, payload);
        if (response.usage) {
            const u = normalizeClaudeUsage(response.usage);
            totalInputTokens += u.promptTokenCount;
            totalOutputTokens += u.candidatesTokenCount;
        }

        const contentBlocks = Array.isArray(response.content) ? response.content : [];
        const currentText = extractTextFromClaudeContent(contentBlocks);
        if (currentText) {
            finalResponseText = currentText;
        }

        // アシスタントの応答を会話履歴に追加
        sessionMessages.push({
            role: 'assistant',
            content: contentBlocks
        });

        const toolUseBlocks = contentBlocks.filter(b => b && b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
            break;
        }

        const toolNames = toolUseBlocks.map(b => b.name).join(', ');
        if (onProgress) {
            onProgress(`MCPツール「${toolNames}」を実行中...`, turnCount);
        }

        const toolResultsContent = [];
        for (const call of toolUseBlocks) {
            const funcName = call.name;
            const funcArgs = call.input || {};
            const toolUseId = call.id;

            console.log(`[MCP Chat Claude] Executing tool: ${funcName}`, funcArgs);
            try {
                const result = await callMcpTool(funcName, funcArgs, user?.allowed_widgets || [], user, req, message);
                artifacts.push({
                    tool: funcName,
                    args: funcArgs,
                    result
                });

                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                toolResultsContent.push({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: resultStr.substring(0, 50000)
                });
            } catch (err) {
                console.error(`[MCP Chat Claude] Tool execution failed for ${funcName}:`, err.message);
                toolResultsContent.push({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: true,
                    content: JSON.stringify({ error: err.message })
                });
            }
        }

        sessionMessages.push({
            role: 'user',
            content: toolResultsContent
        });

        if (onProgress) {
            onProgress(`ツールの実行結果を Claude (${targetModel}) に反映中...`, turnCount);
        }
    }

    // ツール実行後に最終テキストが空だった場合の合成フォールバック
    if (!finalResponseText && artifacts.length > 0) {
        if (onProgress) onProgress('ツール実行結果を元にダッシュボードと回答を合成中...', turnCount + 1);
        const artifactsContext = artifacts.map((a, idx) => {
            const queryInfo = a.args?.query || a.args?.sql || JSON.stringify(a.args);
            const resultStr = typeof a.result === 'string' ? a.result : JSON.stringify(a.result);
            return `### クエリ ${idx + 1} (${a.tool})\n実行パラメータ: ${queryInfo}\n取得データ:\n${resultStr.substring(0, 15000)}`;
        }).join('\n\n');

        const synthRes = await generateTextWithClaude({
            apiKey,
            model: targetModel,
            systemInstruction,
            prompt: `ユーザーからの要求:\n「${message}」\n\nMCPツールにより取得された以下の結果を参照してください:\n\n${artifactsContext}\n\n上記の取得実データを詳細に分析し、インタラクティブなHTMLダッシュボード（\`\`\`html ... \`\`\`コードブロック内）と詳細な解説を必ず日本語で出力してください。`,
            temperature: 0.2,
            maxTokens: 16384
        });
        finalResponseText = synthRes.text;
        if ( synthRes.usageMetadata ) {
            totalInputTokens += synthRes.usageMetadata.promptTokenCount;
            totalOutputTokens += synthRes.usageMetadata.candidatesTokenCount;
        }
    }

    // HTML ダッシュボードが max_tokens (16,384) 上限で途中切断された場合の自動継続生成 (Auto-Continuation)
    if (finalResponseText && typeof finalResponseText === 'string') {
        const lastHtmlIdx = finalResponseText.lastIndexOf('```html');
        if (lastHtmlIdx !== -1) {
            const afterHtml = finalResponseText.substring(lastHtmlIdx + 7);
            const isHtmlUnclosed = !afterHtml.includes('</html>') || !afterHtml.includes('```');
            if (isHtmlUnclosed) {
                console.warn(`[MCP Chat Claude] ⚠️ Detected truncated HTML block at ${finalResponseText.length} chars. Requesting auto-continuation from Claude (${targetModel})...`);
                if (onProgress) {
                    onProgress('大容量ダッシュボードの残りのスクリプト・グラフ描画コードを継続生成中...', turnCount + 1);
                }
                try {
                    const tailContext = finalResponseText.slice(-1500);
                    const contPayload = {
                        model: targetModel,
                        max_tokens: 16384,
                        temperature: 0.1,
                        system: 'あなたはHTML/JavaScriptダッシュボードの継続出力エンジンです。直前の出力がトークン上限で途中切断されました。前置きや挨拶、```html の再宣言は一切行わず、切断された直後の文字から正確に続けて出力し、</script></body></html>``` および分析サマリーまで完全に閉じてください。',
                        messages: [
                            {
                                role: 'user',
                                content: message
                            },
                            {
                                role: 'assistant',
                                content: finalResponseText
                            },
                            {
                                role: 'user',
                                content: `直前の出力が以下の末尾で途中切断されています:\n\n---\n${tailContext}\n---\n\nこの末尾の直後から（重複させずに）続きのJavaScript/HTMLコードのみを出力し、Chart.jsの初期化と</script></body></html>\`\`\`まで確実に完結させてください。`
                            }
                        ]
                    };
                    const contRes = await callAnthropicMessages(apiKey, contPayload);
                    if (contRes.usage) {
                        const cu = normalizeClaudeUsage(contRes.usage);
                        totalInputTokens += cu.promptTokenCount;
                        totalOutputTokens += cu.candidatesTokenCount;
                    }
                    let contText = extractTextFromClaudeContent(contRes.content);
                    if (contText) {
                        // 万が一冒頭に ```javascript や ```html が付いていた場合は除去してシームレスに結合
                        contText = contText.replace(/^```(?:html|javascript|js)?\s*\n?/i, '');
                        finalResponseText += contText;
                        console.log(`[MCP Chat Claude] ✅ Auto-continuation succeeded. Total length: ${finalResponseText.length} chars.`);
                    }
                } catch (contErr) {
                    console.error('[MCP Chat Claude] Auto-continuation failed:', contErr.message);
                }
            }
        }
    }

    const newInteractionId = `claude-mcp-${crypto.randomUUID()}`;
    // 最新のテキストのみに簡略化してセッション保存（メモリ肥大化防止）
    claudeConversations.set(newInteractionId, [
        { role: 'user', content: message },
        { role: 'assistant', content: finalResponseText || '完了しました。' }
    ]);
    if (claudeConversations.size > 100) {
        const oldestKey = claudeConversations.keys().next().value;
        claudeConversations.delete(oldestKey);
    }

    return {
        reply: finalResponseText,
        artifacts,
        usageMetadata: {
            promptTokenCount: totalInputTokens,
            candidatesTokenCount: totalOutputTokens,
            totalTokenCount: totalInputTokens + totalOutputTokens
        },
        interactionId: newInteractionId,
        environmentId: null
    };
}

/**
 * Claude トークン数カウント (`POST /v1/messages/count_tokens` + 文字数推定フォールバック)
 */
async function countClaudeTokens({ apiKey, model, content }) {
    const targetModel = cleanModelId(model, 'claude-sonnet-4-5');
    if (!apiKey) {
        return Math.ceil((content || '').length / 3);
    }
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: targetModel,
                messages: [{ role: 'user', content: content || '' }]
            })
        });
        if (res.ok) {
            const data = await res.json();
            if (typeof data.input_tokens === 'number') {
                return data.input_tokens;
            }
        }
    } catch (e) {
        console.warn('[LLM Adapter] Claude count_tokens fallback:', e.message);
    }
    return Math.ceil((content || '').length / 3);
}

module.exports = {
    INITIAL_CLAUDE_MODELS,
    isClaudeModel,
    isModelAllowedForUser,
    cleanModelId,
    resolveActiveConfig,
    listClaudeModels,
    generateTextWithClaude,
    runClaudeChatJob,
    runClaudeDeepResearchJob,
    runClaudeMcpWorkflow,
    countClaudeTokens
};
