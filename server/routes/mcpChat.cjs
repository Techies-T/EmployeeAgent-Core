const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { GoogleGenAI } = require("@google/genai");
const { getAllMcpToolsForGemini, callMcpTool, getMcpMetadata } = require('../mcpClient.cjs');
const db = require('../db.cjs');
const llmAdapter = require('../services/llmAdapter.cjs');
const mcpHarnessService = require('../services/mcpHarnessService.cjs');

// Initialize Gemini client
function getGeminiClient(apiKey) {
    return new GoogleGenAI({ 
        apiKey: apiKey || process.env.GEMINI_API_KEY,
        httpOptions: { timeout: 180000 } // 180 seconds default timeout for interactions
    });
}

// 経過時間に応じた詳細進捗メッセージの定義（ユーザーに現在の内部処理フェーズを明示）
const PROGRESS_STAGES = {
    initial: [
        { afterSec: 0, text: 'AIモデルへプロンプトを送信中...' },
        { afterSec: 8, text: 'AIが質問の意図を解析し、データ参照計画を立案中...' },
        { afterSec: 25, text: '対象データベースのスキーマ照合およびクエリ引数を設計中...' },
        { afterSec: 50, text: 'AIモデルが最適な分析パラメータを推論中...' },
        { afterSec: 80, text: '推論完了を待機中（複雑な指示の整合性を検証中）...' }
    ],
    generating: [
        { afterSec: 0, text: 'ツールの実行結果をAIモデルに送信中...' },
        { afterSec: 8, text: '取得したデータベース実データを解析中...' },
        { afterSec: 22, text: '比較データ・統計指標の計算とグラフ構造を設計中...' },
        { afterSec: 45, text: 'インタラクティブなChart.js / Tailwind CSS可視化コードを構成中...' },
        { afterSec: 75, text: '大規模ダッシュボードHTMLを出力中（データ量に応じて1〜2分かかります）...' },
        { afterSec: 110, text: 'HTMLの最終構文および閉塞タグ・JavaScriptの完全性を検証中...' },
        { afterSec: 140, text: '生成されたダッシュボードの最終整形・安全チェック中...' }
    ],
    synthesis: [
        { afterSec: 0, text: 'ツール実行結果を元にダッシュボードと回答を合成中...' },
        { afterSec: 12, text: '取得全データを集約し、可視化ダッシュボードHTMLを構築中...' },
        { afterSec: 35, text: 'インタラクティブなChart.jsと集計テーブルを出力中...' },
        { afterSec: 75, text: 'HTMLスクリプトの構文検証と応答を最終化中...' }
    ]
};

/**
 * 経過秒数に応じて動的に進捗メッセージを更新するタイマー
 */
function startProgressTimer(context, turn, onProgress) {
    if (!onProgress) return { stop: () => {}, notifyRetry: () => {} };
    const stages = PROGRESS_STAGES[context] || PROGRESS_STAGES.initial;
    let seconds = 0;
    let currentStageIndex = 0;

    if (stages[0]) onProgress(stages[0].text, turn);

    const interval = setInterval(() => {
        seconds += 3;
        while (currentStageIndex + 1 < stages.length && seconds >= stages[currentStageIndex + 1].afterSec) {
            currentStageIndex++;
            onProgress(stages[currentStageIndex].text, turn);
        }
    }, 3000);

    return {
        stop: () => clearInterval(interval),
        notifyRetry: (attempt, maxRetries) => {
            onProgress(`⚠️ 通信遅延を検知。AI推論を自動再試行中（${attempt}/${maxRetries}回目）...`, turn);
        }
    };
}

/**
 * 確実なタイムアウト制御（Promise.race）を伴う client.interactions.create 呼び出し
 */
function callInteractionsCreateWithTimeout(client, params, options, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                reject(new Error(`API_TIMEOUT: Gemini API呼び出しが ${Math.round(timeoutMs / 1000)}秒 でタイムアウトしました`));
            }
        }, timeoutMs);

        client.interactions.create(params, { ...options, timeout: timeoutMs })
            .then((res) => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timer);
                    resolve(res);
                }
            })
            .catch((err) => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timer);
                    reject(err);
                }
            });
    });
}

/**
 * Executes client.interactions.create with automatic retry for malformed_tool_call, timeouts, and network stalls
 */
async function createInteractionWithRetry(client, params, { timeoutMs = 120000, maxRetries = 2, onProgress = null, turn = 0, progressContext = 'initial' } = {}) {
    let attempt = 0;
    let currentParams = { ...params };
    const progressTracker = startProgressTimer(progressContext, turn, onProgress);

    try {
        while (attempt <= maxRetries) {
            try {
                return await callInteractionsCreateWithTimeout(client, currentParams, {}, timeoutMs);
            } catch (err) {
                const errMsg = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
                const lower = errMsg.toLowerCase();

                const isMalformed = errMsg.includes('malformed_tool_call') ||
                                    errMsg.includes('invalid JSON syntax') ||
                                    (err.status === 400 && errMsg.includes('JSON'));

                const isMaxTokenLimitError = (err.status === 400 || lower.includes('invalid_argument')) &&
                                             (lower.includes('max_output_tokens') || lower.includes('output_tokens') || lower.includes('output token'));

                const isTimeoutOrNetwork = lower.includes('timeout') ||
                                           lower.includes('etimedout') ||
                                           lower.includes('esockettimedout') ||
                                           lower.includes('econnreset') ||
                                           lower.includes('fetch failed') ||
                                           lower.includes('socket hang up') ||
                                           lower.includes('504') ||
                                           lower.includes('503') ||
                                           lower.includes('502') ||
                                           lower.includes('overloaded') ||
                                           lower.includes('resource_exhausted');

                if (isMaxTokenLimitError && currentParams.generation_config?.max_output_tokens > 8192) {
                    const currentMax = currentParams.generation_config.max_output_tokens;
                    const matchLimit = errMsg.match(/(?:maximum|<=|limit).*?(\d{4,6})/i);
                    const nextMax = matchLimit ? parseInt(matchLimit[1], 10) : (currentMax > 32768 ? 32768 : (currentMax > 16384 ? 16384 : 8192));
                    console.warn(`[MCP Chat] Model output token ceiling detected (${errMsg.substring(0, 100)}). Auto-adjusting max_output_tokens: ${currentMax} -> ${nextMax}...`);
                    currentParams = {
                        ...currentParams,
                        generation_config: {
                            ...currentParams.generation_config,
                            max_output_tokens: nextMax
                        }
                    };
                    continue;
                }

                if (isMalformed && attempt < maxRetries) {
                    attempt++;
                    console.warn(`[MCP Chat] Warning: malformed_tool_call encountered (Attempt ${attempt}/${maxRetries}). Retrying with corrected JSON instructions...`);
                    const correctionNotice = "\n\nCRITICAL SYSTEM REQUIREMENT: Your previous tool call produced malformed JSON syntax. You MUST format all function call arguments as strictly valid JSON strings. Escape all double quotes (\") and newlines (\\n) properly.";
                    currentParams = {
                        ...currentParams,
                        system_instruction: (currentParams.system_instruction || '') + correctionNotice
                    };
                    progressTracker.notifyRetry(attempt, maxRetries);
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }

                if (isTimeoutOrNetwork && attempt < maxRetries) {
                    attempt++;
                    console.warn(`[MCP Chat] Warning: API timeout or network stall encountered (${errMsg.substring(0, 100)}) (Attempt ${attempt}/${maxRetries}). Retrying...`);
                    progressTracker.notifyRetry(attempt, maxRetries);
                    // 指数バックオフ (2s, 4s)
                    await new Promise(r => setTimeout(r, attempt * 2000));
                    continue;
                }

                throw err;
            }
        }
    } finally {
        progressTracker.stop();
    }
}

/**
 * interaction オブジェクトから生成テキストを堅牢に抽出するヘルパー関数
 */
function extractTextFromInteraction(interaction) {
    if (!interaction) return "";

    // 1. output_text プロパティ（公式トップレベル出力）
    if (interaction.output_text && typeof interaction.output_text === 'string' && interaction.output_text.trim()) {
        return interaction.output_text.trim();
    }

    // 2. steps 配列の走査（最後の model_output から優先取得）
    if (Array.isArray(interaction.steps) && interaction.steps.length > 0) {
        for (let i = interaction.steps.length - 1; i >= 0; i--) {
            const step = interaction.steps[i];
            if (step.type === 'model_output') {
                if (Array.isArray(step.content)) {
                    const text = step.content
                        .map(p => (typeof p === 'string' ? p : p?.text || ''))
                        .filter(Boolean)
                        .join('\n');
                    if (text.trim()) return text.trim();
                } else if (typeof step.content === 'string' && step.content.trim()) {
                    return step.content.trim();
                } else if (step.text && typeof step.text === 'string' && step.text.trim()) {
                    return step.text.trim();
                }
            }
        }
    }

    // 3. text / outputs プロパティのフォールバック
    if (interaction.text && typeof interaction.text === 'string' && interaction.text.trim()) {
        return interaction.text.trim();
    }

    return "";
}

/**
 * デフォルトの MCP Chat システム指示（ハーネス定義）
 * スケール分離ルール、トークン制約、NPB/行政手続きスキーマ参照、GenUI完全性を含む
 */
const DEFAULT_MCP_CHAT_SYSTEM_INSTRUCTION = `You are a helpful IT Operations, Data Analytics, and System Management Assistant. You have access to various external tools via the Model Context Protocol (MCP). Use these tools to fetch information, monitor systems, and perform actions. Always format your output nicely using Markdown.

CRITICAL TOOL ROUTING & DATA SOURCE SELECTION (ABSOLUTE MANDATORY):
Multiple MCP servers are connected across different domains. Always select the exact MCP tool corresponding to the user's target domain:
1. **Knowledge Base MCP (ナレッジベース分析・トークン集計・記事投稿統計)**:
   - Tools: \`get_knowledge_token_crosstab\`, \`get_knowledge_token_counts\`, \`get_author_post_counts\`
   - Whenever the user asks about **author (著者別)**, **monthly/quarterly/yearly post counts (記事投稿数)**, **input tokens (インプットトークン)**, **output tokens (アウトプットトークン)**, **token counts (トークン数)**, or **cross-tabulation / pivot tables of tokens (クロス集計表)**, you MUST ALWAYS call the Knowledge Base MCP tools (\`get_knowledge_token_crosstab\`, \`get_knowledge_token_counts\`, or \`get_author_post_counts\`).
   - **NEVER** call MariaDB tools (\`list_tables\`, \`describe_table\`, \`read_query\`) for knowledge base, author post counts, or token usage queries! Knowledge Base data resides in the internal Knowledge Base MCP, NOT in MariaDB.
2. **MariaDB / NPB Baseball Analytics MCP (プロ野球データ・企業DB)**:
   - Tools: \`list_tables\`, \`describe_table\`, \`read_query\`, \`write_query\`
   - Use ONLY when querying NPB baseball statistics (\`players\`, \`teams\`, \`team_standings\`, \`batting_stats\`, \`pitching_stats\`, \`games\`) or explicitly requested MariaDB tables.
3. **Digital Agency Administrative Procedures MCP (デジタル庁 行政手続統計)**:
   - Tools: \`query_records\`, \`summarize_records\`
   - Use when analyzing administrative procedures, life events, or required attachments.
4. **Meta-Catalog MCP (データカタログ・GenUIメタ情報)**:
   - Tools: \`list_catalog\`, \`get_catalog_detail\`
   - Use to inspect enterprise data schemas and recommended GenUI dashboard specifications.

CRITICAL TOOL ARGUMENT SYNTAX (ABSOLUTE MANDATORY):
When calling any tool with arguments (especially SQL queries or multi-line strings):
1. Always generate STRICTLY VALID JSON for the tool call arguments.
2. Properly escape all double quotes (\") and newlines (\\n) inside string arguments.
3. NEVER generate unescaped raw newlines, quotes, or control characters inside JSON values.

Knowledge Base MCP Reference:
- \`get_knowledge_token_crosstab\`: Returns a cross-tabulated pivot table of Input Tokens and Output Tokens grouped by time period (\`period\`: \`"monthly"\`, \`"quarterly"\`, \`"half-yearly"\`, \`"yearly"\`) as rows and Author as columns. Use this immediately when asked for a cross-tabulation (クロス集計) of input/output tokens by month/period and author.
- \`get_knowledge_token_counts\`: Returns total, input, and output token counts grouped by \`groupBy\` (\`"article"\`, \`"author"\`, \`"monthly"\`, \`"quarterly"\`, \`"half-yearly"\`, \`"yearly"\`).
- \`get_author_post_counts\`: Returns the number of knowledge base articles posted by each author grouped by \`period\` (\`"monthly"\`, \`"quarterly"\`, \`"half-yearly"\`, \`"yearly"\`).

Database Schema Reference (MariaDB NPB):
- ZTA STRICT DATA ISOLATION RULE:
  - Actual statistics, win-loss records, standings, and player metrics are NOT stored in this system prompt.
  - You MUST retrieve all data exclusively by executing the authorized MariaDB MCP tools (\`list_tables\`, \`describe_table\`, \`read_query\`).
  - If the MariaDB MCP tools are not available in your tool list or return an authorization/connection error, DO NOT generate a dashboard from pre-existing knowledge or prompt text; clearly report that the database tool is unavailable or unauthorized.
- Table \`players\`: \`player_id\` (PRIMARY KEY, INT), \`team_id\` (VARCHAR), \`name\` (VARCHAR), \`position\` (VARCHAR), \`bats_throws\` (VARCHAR)
  CRITICAL: The primary key of \`players\` is \`player_id\` (NOT \`id\`).
- Table \`teams\`: \`team_id\` (PRIMARY KEY, VARCHAR), \`team_name\` (VARCHAR), \`league\` (VARCHAR), \`wins\`, \`losses\`, \`draws\`, \`win_rate\`, \`games_behind\`, \`runs_scored\`, \`runs_allowed\`
  CRITICAL: The columns are \`team_id\` and \`team_name\` (NOT \`id\` and NOT \`name\`).
  Join syntax: \`JOIN teams ON players.team_id = teams.team_id\`
- Table \`team_standings\`: \`id\` (PK, INT), \`team_id\` (VARCHAR), \`team_name\` (VARCHAR), \`league\` (VARCHAR), \`year\` (INT), \`wins\`, \`losses\`, \`draws\`, \`win_rate\`, \`games_behind\`, \`runs_scored\`, \`runs_allowed\`
- Table \`batting_stats\`: \`id\` (PK, INT), \`player_id\` (INT), \`year\` (INT), \`at_bats\`, \`hits\`, \`home_runs\`, \`rbi\`, \`risp_at_bats\`, \`risp_hits\`, \`risp_avg\`, \`batting_avg\`, \`obp\`, \`slg\`, \`ops\`, \`woba\`, \`walks\`, \`strikeouts\`, \`war\`, \`waa\`, \`title_awards\`
  Join syntax: \`JOIN players ON batting_stats.player_id = players.player_id\`
- Table \`pitching_stats\`: \`id\` (PK, INT), \`player_id\` (INT), \`year\` (INT), \`games\`, \`games_started\`, \`wins\`, \`losses\`, \`saves\`, \`holds\`, \`innings_pitched\`, \`hits_allowed\`, \`runs_allowed\`, \`earned_runs\`, \`home_runs_allowed\`, \`walks\`, \`strikeouts\`, \`era\`, \`whip\`, \`fip\`, \`war\`, \`waa\`, \`title_awards\`
  Join syntax: \`JOIN players ON pitching_stats.player_id = players.player_id\`
- Table \`games\`: \`id\` (PK, INT), \`game_date\` (DATE), \`season_year\` (INT), \`game_type\` (VARCHAR: 'Regular', 'Interleague', 'CS_Final', 'JapanSeries'), \`home_team\` (VARCHAR), \`away_team\` (VARCHAR), \`home_score\` (INT), \`away_score\` (INT), \`stadium\` (VARCHAR), \`winning_pitcher\` (VARCHAR), \`losing_pitcher\` (VARCHAR), \`save_pitcher\` (VARCHAR), \`notes\` (VARCHAR)
  Use this table to analyze head-to-head records (対戦成績), CS results, and Japan Series matchups.

Digital Agency Procedures Reference:
- Tool \`query_records\` / \`summarize_records\`: dataset_name is "procedures"
- Key fields: \`procedure_id\`, \`name\`, \`ministry\`, \`online_status\`, \`online_rate\`, \`annual_applications\`, \`life_event\`, \`required_attachments\`

Meta-Catalog MCP (Data Schema & GenUI Guidelines):
If you need to query enterprise databases or build specialized GenUI dashboards, you can consult the Meta-Catalog MCP tools (\`list_catalog\` and \`get_catalog_detail\`) to retrieve the exact table schemas, column names, sample queries, and recommended GenUI layout patterns.

Generative UI & Interactive Visual Reports (ABSOLUTE MANDATORY REQUIREMENT):
Whenever the user asks for a dashboard ("ダッシュボード"), visual report ("可視化"), comparison chart ("比較"), analysis ("分析"), widget ("GenUI" / "ウィジェット"), or comparative statistics:
1. YOU MUST ALWAYS GENERATE A COMPLETE, SELF-CONTAINED, FULLY INTERACTIVE HTML WIDGET INSIDE AN \`\`\`html ... \`\`\` CODE BLOCK!
   DO NOT ONLY PROVIDE PLAIN TEXT OR MARKDOWN TABLES. You MUST produce the full \`\`\`html ... \`\`\` code block.
2. The HTML widget must be beautiful, modern, and include:
   - Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
   - Chart.js: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
   - Lucide/FontAwesome or SVG icons, sleek dark/light theme, and polished typography.
   - Compact JS Data & Dynamic Rendering (CRITICAL TO AVOID TOKEN LIMIT):
     Do NOT write dozens of repetitive HTML <tr>/<td> rows manually. Instead, embed the queried data as clean JavaScript objects/arrays (e.g. \`const batterData = [...]\`, \`const starterData = [...]\`) in \`<script>\`, and render the table rows and Chart.js charts dynamically using JavaScript (\`innerHTML = data.map(...).join('')\`). This keeps the HTML compact and fast.
    - Token Limit Prevention & Code Completeness (ABSOLUTE MANDATORY):
      Select ONLY the top 5 to 8 standout key players/entities per category (e.g. top 6 batters, top 6 starters, top 6 relievers) to keep the JavaScript data concise and highly relevant. DO NOT embed dozens of repetitive player records.
      The HTML and \`<script>\` code MUST be 100% complete and fully closed with \`</script></body></html>\`. NEVER allow the script to be truncated mid-statement. Wrap all initialization inside \`try { ... } catch (err) { console.error("Dashboard init error:", err); }\` to guarantee robustness.
   - Script Initialization: Initialize charts and tables immediately if document.readyState is not 'loading', or listen on both DOMContentLoaded and load events.
3. For NPB Baseball Analytics Dashboards:
   - Top 3 Stat Cards: ①「最大跳躍スラッガー」(大幅WAR/本塁打増野手), ②「最大跳躍エース」(大幅防御率/投球回改善先発), ③「鉄壁リリーフ進化」(大幅S/H増加守護神/セットアッパー).
   - Clean Tabs: [⚾ 野手編 (2カ年比較)], [🎯 先発投手編 (2カ年比較)], [🛡️ 救援投手編 (クローザー＆中継ぎ)].
   - Chart.js 2-Year Grouped Bar Charts: 2024 (Slate/Gray: #64748b) vs 2025 (Royal Blue: #2563eb / Accent Yellow: #eab308) side-by-side.
   - Badge Pills: Next to metrics, show "+3.4 ▲" in emerald green or "-0.3 ▼" in red pill badges.
   - Click-Interactive Detail Cards: Clicking a chart bar or table row dynamically updates a comprehensive player stat card with all metrics (AVG, HR, RBI, OPS, Titles, ERA, WHIP, K, SV, HLD).
   - Pitching Dominance Matrix: Scatter plot of WHIP (X-axis) vs ERA (Y-axis) with the note: "※左下（WHIP 1.00未満・防御率1点台）が絶対的守護神・エースの領域".
   - AI Analyst Commentary: Insightful analytical text at the bottom.
4. For Digital Agency Procedures Analytics:
   - Follow the Meta-Catalog spec: Top KPIs, horizontal bar chart for life events, doughnut chart for required attachments, and filterable procedure table.

Interactive GenUI & Data Analytics Generation Guidelines:
1. Fetch necessary data efficiently using targeted WHERE / LIMIT clauses or aggregates.
2. Generate comprehensive, sleek, and highly interactive HTML dashboard widgets within \`\`\`html ... \`\`\` code block.
3. For Chart.js and player tables, feature the standout key performers, metrics, and comparisons with rich visual hierarchy.
4. CRITICAL: The \`\`\`html ... \`\`\` block MUST be completely finished with proper closing tags (</script>, </body>, </html>, and \`\`\`). Keep embedded datasets focused so that the entire script and styling finish cleanly without mid-sentence truncation.
5. Multi-Scale Data Visualization & Scale Separation Rule (CRITICAL):
   - NEVER plot metrics with vastly different scales or units (e.g. 1-game averages [1-10] vs season totals [100-800], or batting averages [0.200-0.350] vs home runs [10-50]) on the same single Y-axis! Doing so flattens and squashes the smaller values to the ground.
   - Always apply one of the following 3 patterns:
     a) Dedicated Side-by-Side Cards/Charts (Recommended): Separate them into two distinct charts (e.g. Left chart: 1試合平均 [0-6点], Right chart: シーズン累計得失差 [0-300点]).
     b) Dual Y-Axes: Use left Y-axis for rate/per-game metrics and right Y-axis for totals/differences.
     c) Metric Toggle Buttons: Provide interactive buttons to switch metrics with dynamic Y-axis auto-scaling.`;

/**
 * MCP ワークフロー実行コア関数（同期・非同期共通）
 */
async function executeMcpWorkflow({ user, message, previous_interaction_id, environment_id, req, onProgress, checkCancelled, pipelineDomain, model }) {
    const workflowStartTime = Date.now();
    const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

    if (!apiKey && !claudeApiKey) {
        throw new Error('Gemini API Key または Claude API Key が設定されていません。System Settings で設定してください。');
    }

    const globalGeminiModel = await db.getSetting('GEMINI_MODEL') || 'gemini-3.6-flash';
    const globalClaudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
    const configuredMcpModel = await db.getSetting('GEMINI_MCP_CHAT_MODEL');
    const configuredClaudeMcpModel = await db.getSetting('CLAUDE_MCP_CHAT_MODEL');
    const mcpAiProvider = (await db.getSetting('MCP_AI_PROVIDER')) || aiProvider;

    const defaultMcpModel = (configuredMcpModel && llmAdapter.isClaudeModel(configuredMcpModel))
        ? configuredMcpModel
        : (mcpAiProvider === 'claude' ? (configuredClaudeMcpModel || globalClaudeModel) : (configuredMcpModel || globalGeminiModel));

    // AdminがSystem Settingsで設定したデフォルトAIモデルを自動的に強制適用
    let modelName = defaultMcpModel;

    // Get MCP Tools filtered by user's permissions (ZTA-compliant PDP check)
    let mcpTools = await getAllMcpToolsForGemini(user?.allowed_widgets || [], user);

    // Dynamic Multi-Domain Pipeline Routing:
    // 1. Explicit pipelineDomain selected in UI
    // 2. Auto intent detection supporting both single-domain focus and multi-domain composite queries
    const msgLower = (message || '').toLowerCase();
    const isMetaListQuery = msgLower.includes('ツール') && (msgLower.includes('一覧') || msgLower.includes('利用可能') || msgLower.includes('コネクション') || msgLower.includes('available'));

    if (pipelineDomain && pipelineDomain !== 'auto') {
        const filtered = mcpTools.filter(t => {
            if (t.domain === pipelineDomain) return true;
            // Allow Meta-Catalog tools alongside analytics domains
            if (t.domain === 'catalog' && (pipelineDomain === 'npb_baseball' || pipelineDomain === 'digital_agency')) return true;
            return false;
        });
        if (filtered.length > 0) {
            console.log(`[mcpChat] Explicit Pipeline '${pipelineDomain}' active. Bound ${filtered.length} tools.`);
            mcpTools = filtered;
        }
    } else if (!isMetaListQuery) {
        const matchedDomains = mcpHarnessService.matchDomainsForPrompt(message || '');

        const isBaseball = msgLower.includes('阪神') || msgLower.includes('タイガース') || msgLower.includes('ホークス') ||
                           msgLower.includes('npb') || msgLower.includes('野球') || msgLower.includes('セ・リーグ') || msgLower.includes('パ・リーグ') ||
                           msgLower.includes('batting') || msgLower.includes('pitching') ||
                           msgLower.includes('war') || msgLower.includes('立役者') ||
                           msgLower.includes('打者') || msgLower.includes('投手') || msgLower.includes('野手') || msgLower.includes('防御率') || msgLower.includes('打率');

        const isProcedures = msgLower.includes('行政') || msgLower.includes('手続') ||
                             msgLower.includes('デジタル庁') || msgLower.includes('マイナンバー') ||
                             msgLower.includes('住民票') || msgLower.includes('戸籍') || msgLower.includes('procedures');

        const isKnowledge = msgLower.includes('ナレッジ') || msgLower.includes('knowledge') ||
                            msgLower.includes('マニュアル') || msgLower.includes('社内規程') ||
                            msgLower.includes('インプットトークン') || msgLower.includes('アウトプットトークン') ||
                            msgLower.includes('input_token') || msgLower.includes('output_token') ||
                            msgLower.includes('トークン') || msgLower.includes('token') ||
                            msgLower.includes('著者') || msgLower.includes('author') ||
                            msgLower.includes('投稿数') || msgLower.includes('記事') ||
                            msgLower.includes('クロス集計') || msgLower.includes('crosstab');

        const isWorkspace = msgLower.includes('カレンダー') || msgLower.includes('calendar') ||
                            msgLower.includes('予定') || msgLower.includes('ミーティング') || msgLower.includes('会議') ||
                            msgLower.includes('todo') || msgLower.includes('タスク') || msgLower.includes('gmail');

        if (isBaseball) {
            matchedDomains.add('npb_baseball');
            matchedDomains.add('catalog');
        }
        if (isProcedures) {
            matchedDomains.add('digital_agency');
            matchedDomains.add('catalog');
        }
        if (isKnowledge) {
            matchedDomains.add('knowledge_base');
        }
        if (isWorkspace) {
            matchedDomains.add('google_workspace');
        }

        if (matchedDomains.size > 0) {
            const filtered = mcpTools.filter(t => {
                if (t.domain && matchedDomains.has(t.domain)) return true;
                // Fallback for tools without domain metadata
                if (matchedDomains.has('knowledge_base') && (t.name.includes('knowledge') || t.name.includes('author') || t.name.includes('post') || t.name.includes('crosstab'))) return true;
                if (matchedDomains.has('npb_baseball') && (t.name.includes('query') || t.name.includes('sql') || t.name.includes('table') || t.name.includes('catalog'))) return true;
                if (matchedDomains.has('digital_agency') && (t.name.includes('procedures') || t.name.includes('records') || t.name.includes('catalog'))) return true;
                return false;
            });

            if (filtered.length > 0) {
                console.log(`[mcpChat] Auto Multi-Domain Pipeline [${Array.from(matchedDomains).join(', ')}] active. Bound ${filtered.length} tools: ${filtered.map(t => t.name).join(', ')}`);
                mcpTools = filtered;
            }
        }
    }
    
    const tools = mcpTools.map(t => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters
    }));

    console.log(`[mcpChat] Sending ${tools.length} tools to Gemini. Available tool names: ${tools.map(t => t.name).join(', ')}`);

    const toolDescriptions = mcpTools.map(t => `- **${t.name}** (${t.serverName || 'MCP'}): ${t.description}`).join('\n');

    // Collect dynamic domain routing instructions & ZTA Universal Grant scope guards
    const activeDomainInstructions = Array.from(new Set(mcpTools.map(t => t.routingInstruction).filter(Boolean)));
    const activeScopeGuards = Array.from(new Set(mcpTools.map(t => t.scopePromptGuard).filter(Boolean)));
    const hasDirectPublicServer = mcpTools.some(t => t.connectionMode === 'direct_public');
    const harnessCfg = mcpHarnessService.getHarnessConfig();
    const directPublicGuard = hasDirectPublicServer && harnessCfg?.global_routing?.public_direct_guard
        ? `\n[Direct Public MCP Outbound Guard]: ${harnessCfg.global_routing.public_direct_guard}`
        : '';

    const ztaGuardSection = (activeScopeGuards.length > 0 || activeDomainInstructions.length > 0 || directPublicGuard)
        ? `\n\nZTA ROLE DATA SCOPE & DYNAMIC HARNESS RULES (MANDATORY):\n` +
          activeDomainInstructions.map(inst => `- [Domain Routing]: ${inst}`).join('\n') +
          (activeScopeGuards.length > 0 ? '\n' + activeScopeGuards.map(g => `- [Role Scope Constraint]: ${g}`).join('\n') : '') +
          directPublicGuard
        : '';

    const customInstruction = await db.getSetting('MCP_CHAT_SYSTEM_INSTRUCTION');
    const baseInstruction = (customInstruction && customInstruction.trim()) ? customInstruction.trim() : DEFAULT_MCP_CHAT_SYSTEM_INSTRUCTION;

    const systemInstruction = `${baseInstruction}${ztaGuardSection}

If the user asks what tools are available or what you can do, explicitly list the exact names and descriptions of the tools provided below:

Available Tools:
${toolDescriptions}`;

    if (onProgress) onProgress('AIモデルへプロンプトを送信中...', 0);

    const maxTurnsSetting = parseInt(await db.getSetting('MCP_CHAT_MAX_TURNS'), 10);
    let maxTurns = (!isNaN(maxTurnsSetting) && maxTurnsSetting > 0) ? maxTurnsSetting : 15;

    const useClaude = (llmAdapter.isClaudeModel(modelName) && !!claudeApiKey) || (!apiKey && !!claudeApiKey);
    if (useClaude) {
        const targetClaudeModel = llmAdapter.isClaudeModel(modelName) ? modelName : globalClaudeModel;
        console.log(`[mcpChat] Executing MCP workflow via Anthropic Claude (${targetClaudeModel})...`);
        const claudeRes = await llmAdapter.runClaudeMcpWorkflow({
            apiKey: claudeApiKey,
            model: targetClaudeModel,
            user,
            message,
            previous_interaction_id,
            mcpTools,
            callMcpTool,
            systemInstruction,
            maxTurns,
            onProgress,
            checkCancelled,
            req
        });
        return {
            ...claudeRes,
            model: targetClaudeModel,
            durationSeconds: Math.max(1, Math.round((Date.now() - workflowStartTime) / 1000))
        };
    }

    const client = getGeminiClient(apiKey);
    const modelLower = (modelName || '').toLowerCase();
    const MAX_OUTPUT_TOKENS = (modelLower.includes('argon') || modelLower.includes('carbon')) ? 32768 : 65536;

    let currentInteractionId = previous_interaction_id;
    let currentEnvironmentId = environment_id;

    let interaction = await createInteractionWithRetry(client, {
        model: modelName,
        input: message,
        previous_interaction_id: currentInteractionId || undefined,
        environment: currentEnvironmentId || "remote",
        system_instruction: systemInstruction,
        tools: tools.length > 0 ? tools : undefined,
        generation_config: {
            temperature: 0.2,
            max_output_tokens: MAX_OUTPUT_TOKENS
        }
    }, {
        timeoutMs: 120000,
        maxRetries: 2,
        onProgress,
        turn: 0,
        progressContext: 'initial'
    });

    currentInteractionId = interaction.id;
    currentEnvironmentId = interaction.environment_id;

    let turnCount = 0;
    let finalResponseText = "";
    let artifacts = [];
    let synthesizedUsageMetadata = null;
    let steps = interaction.steps || [];

    while (maxTurns > 0) {
        if (checkCancelled && await checkCancelled()) {
            throw new Error('タスクがユーザーによりキャンセルされました');
        }

        maxTurns--;
        turnCount++;
        
        const lastStep = steps[steps.length - 1];
        if (!lastStep) break;

        const currentText = extractTextFromInteraction(interaction);
        if (currentText) {
            finalResponseText = currentText;
            if (lastStep.type === 'model_output') {
                break;
            }
        }

        if (lastStep.type === 'function_call') {
            const functionCalls = [];
            for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].type === 'function_call') {
                    functionCalls.unshift(steps[i]);
                } else {
                    break;
                }
            }

            if (functionCalls.length > 0) {
                const functionResponses = [];
                const toolNames = functionCalls.map(c => c.name).join(', ');
                if (onProgress) onProgress(`MCPツール「${toolNames}」を実行中...`, turnCount);
                
                for (const call of functionCalls) {
                    const funcName = call.name;
                    const funcArgs = call.arguments || {};
                    const funcId = call.id;
                    
                    console.log(`[MCP Chat] Executing tool: ${funcName}`, funcArgs);
                    if (funcArgs && (funcArgs.query || funcArgs.sql)) {
                        console.log(`[MCP AI Query] 🤖 AI発行クエリ [${funcName}]:\n${funcArgs.query || funcArgs.sql}`);
                    }
                    
                    try {
                        const result = await callMcpTool(funcName, funcArgs, user.allowed_widgets || [], user, req, message);
                        
                        artifacts.push({
                            tool: funcName,
                            args: funcArgs,
                            result: result
                        });

                        functionResponses.push({
                            type: 'function_result',
                            call_id: funcId,
                            name: funcName,
                            result: result
                        });
                    } catch (err) {
                        console.error(`[MCP Chat] Tool execution failed for ${funcName}:`, err.message);
                        if (err.message && (err.message.includes('Access denied') || err.message.includes('not permitted') || err.message.includes('disabled'))) {
                            console.warn(`[SECURITY AUDIT] 🚨 DOUBLE-CHECK BLOCKED: AI attempted unauthorized/prohibited tool '${funcName}' for user ${user?.email || 'unknown'}: ${err.message}`);
                        }
                        functionResponses.push({
                            type: 'function_result',
                            call_id: funcId,
                            name: funcName,
                            result: { error: err.message },
                            is_error: true
                        });
                    }
                }

                // Deep-reasoning モデル (Argon / Carbon 等) が必要な全テーブルの実データ取得クエリを完了した場合、
                // 非ストリーミングの interactions.create で180秒タイムアウトするのを防ぎ、
                // 即座にストリーミング＋途中再開（Auto-Resume）対応のダッシュボード合成へ移行する
                const dataQueryCount = artifacts.filter(a => !['list_tables', 'describe_table'].includes(a.tool)).length;
                const isDeepReasoningModel = modelLower.includes('argon') || modelLower.includes('carbon');
                const requiredTables = ['batting_stats', 'pitching_stats', 'games', 'team_standings'].filter(tbl => msgLower.includes(tbl));
                const queriedSqlText = artifacts.map(a => String(a.args?.query || a.args?.sql || '')).join(' ').toLowerCase();
                const hasAllRequiredTables = requiredTables.every(tbl => queriedSqlText.includes(tbl));

                if (isDeepReasoningModel && hasAllRequiredTables && ((turnCount >= 2 && dataQueryCount >= 3) || dataQueryCount >= 4)) {
                    console.log(`[MCP Chat] 🚀 Deep-reasoning model (${modelName}) collected ${dataQueryCount} data queries across all required tables (${artifacts.length} total tools, turn ${turnCount}). Switching directly to streaming dashboard synthesis with checkpoint auto-resume...`);
                    break;
                }
                
                if (onProgress) onProgress(`ツールの実行結果をモデルに反映中...`, turnCount);

                const availableTools = (maxTurns > 0 && tools.length > 0) ? tools : undefined;

                try {
                    interaction = await createInteractionWithRetry(client, {
                        model: modelName,
                        input: functionResponses,
                        previous_interaction_id: currentInteractionId,
                        environment: currentEnvironmentId,
                        system_instruction: systemInstruction,
                        tools: availableTools,
                        generation_config: {
                            temperature: 0.2,
                            max_output_tokens: MAX_OUTPUT_TOKENS
                        }
                    }, {
                        timeoutMs: 180000,
                        maxRetries: artifacts.length >= 2 ? 0 : 1,
                        onProgress,
                        turn: turnCount,
                        progressContext: 'generating'
                    });

                    currentInteractionId = interaction.id;
                    currentEnvironmentId = interaction.environment_id;
                    steps = interaction.steps || [];
                } catch (turnErr) {
                    if (artifacts.length > 0) {
                        console.warn(`[MCP Chat] ⚠️ Turn ${turnCount} interaction timed out after collecting ${artifacts.length} tool results (${turnErr.message}). Breaking out to streaming synthesis with auto-resume...`);
                        break;
                    }
                    throw turnErr;
                }
                
            } else {
                break;
            }
        } else {
            break;
        }
    }

    if (!finalResponseText) {
        finalResponseText = extractTextFromInteraction(interaction);
    }

    // ツール呼び出し後にテキストが空（または途切れ）の場合、取得全データを元に
    // ストリーミング＋チェックポイント自動再開（Auto-Resume）方式でダッシュボードを合成
    if (!finalResponseText && artifacts.length > 0) {
        console.log(`[MCP Chat] Starting streaming dashboard synthesis with checkpoint auto-resume (${artifacts.length} tool results collected)...`);
        if (onProgress) onProgress('取得データを元にHTML/SVGダッシュボードをストリーミング構築中...', turnCount + 1);
        try {
            const artifactsContext = artifacts.map((a, idx) => {
                const queryInfo = a.args?.query || a.args?.sql || JSON.stringify(a.args);
                const resultStr = typeof a.result === 'string' ? a.result : JSON.stringify(a.result);
                return `### クエリ ${idx + 1} (${a.tool})\n実行SQL/パラメータ: ${queryInfo}\n取得データ:\n${resultStr.substring(0, 15000)}`;
            }).join('\n\n');

            const synthesisPrompt = `あなたは高度なデータアナリスト兼システム管理者です。\nユーザーからの要求:\n「${message}」\n\nMCPツールにより取得された以下のデータベース/システム結果を参照してください:\n\n${artifactsContext}\n\n【指示】\n上記の取得実データを詳細に分析し、ユーザーの要求に完全に回答してください。\nインタラクティブなHTMLダッシュボード（必ず\`\`\`html ... \`\`\`コードブロック内）と詳細な解説を必ず日本語で出力してください。`;

            const cleanModel = modelName.replace(/^models\//, '');
            const initialUsage = interaction?.usage || interaction?.usage_metadata || interaction?.usageMetadata || {};
            let totalPromptTokens = initialUsage.promptTokenCount || initialUsage.prompt_token_count || initialUsage.total_input_tokens || initialUsage.input_tokens || 0;
            let totalCandidateTokens = initialUsage.candidatesTokenCount || initialUsage.candidates_token_count || initialUsage.total_output_tokens || initialUsage.output_tokens || 0;

            const synthesisSystemInstruction = `${baseInstruction}\n\nNOTE FOR SYNTHESIS PHASE: All required MCP database tool executions have ALREADY been completed and their exact results are embedded directly in the user prompt below. Do NOT attempt to invoke any additional tools or report tools as unavailable. Generate the complete interactive HTML dashboard (\`\`\`html ... \`\`\`) and detailed Japanese analysis immediately from the provided query results.`;

            let accumulatedText = '';
            let maxMaxOutputTokens = MAX_OUTPUT_TOKENS;

            const hasUnclosedHtmlBlock = (text) => {
                if (!text || typeof text !== 'string') return false;
                const lastHtml = text.lastIndexOf('```html');
                if (lastHtml === -1) return false;
                const afterHtml = text.substring(lastHtml + 7);
                if (!afterHtml.includes('```')) return true;
                if ((afterHtml.includes('<html') || afterHtml.includes('<!DOCTYPE html')) && !afterHtml.toLowerCase().includes('</html>')) {
                    return true;
                }
                return false;
            };

            const runStreamingPass = async (contentsPayload, passLabel, passIndex) => {
                let lastReportedLength = accumulatedText.length;
                let passUsage = null;

                const streamPromise = (async () => {
                    let stream;
                    try {
                        stream = await client.models.generateContentStream({
                            model: cleanModel,
                            contents: contentsPayload,
                            config: {
                                systemInstruction: synthesisSystemInstruction,
                                temperature: 0.2,
                                maxOutputTokens: maxMaxOutputTokens
                            }
                        });
                    } catch (initErr) {
                        const msg = initErr?.message || String(initErr);
                        const limitMatch = msg.match(/maximum allowed value \((\d+)\)/i) || msg.match(/at most (\d+)/i);
                        if (limitMatch && limitMatch[1]) {
                            maxMaxOutputTokens = parseInt(limitMatch[1], 10);
                            console.warn(`[MCP Chat] Adjusted generateContentStream maxOutputTokens to ${maxMaxOutputTokens}`);
                            stream = await client.models.generateContentStream({
                                model: cleanModel,
                                contents: contentsPayload,
                                config: {
                                    systemInstruction: synthesisSystemInstruction,
                                    temperature: 0.2,
                                    maxOutputTokens: maxMaxOutputTokens
                                }
                            });
                        } else {
                            throw initErr;
                        }
                    }

                    // チャンク単位のアイドル監視（トークンが流れている限り全体で何分かかってもタイムアウトさせない）
                    let idleTimer = null;
                    const resetIdleTimer = (ms, rejectFn) => {
                        if (idleTimer) clearTimeout(idleTimer);
                        idleTimer = setTimeout(() => {
                            rejectFn(new Error(`STREAM_IDLE_TIMEOUT: ${ Math.round(ms / 1000) }秒間チャンク受信がありませんでした`));
                        }, ms);
                    };

                    const iterator = stream[Symbol.asyncIterator]();
                    let isFirstChunk = true;

                    try {
                        while (true) {
                            if (checkCancelled && await checkCancelled()) {
                                throw new Error('タスクがユーザーによりキャンセルされました');
                            }
                            const timeoutMs = isFirstChunk ? 180000 : 90000;
                            const nextResult = await new Promise((resolve, reject) => {
                                resetIdleTimer(timeoutMs, reject);
                                iterator.next().then(resolve, reject);
                            });
                            if (idleTimer) clearTimeout(idleTimer);

                            if (nextResult.done) break;
                            isFirstChunk = false;

                            const chunk = nextResult.value;
                            let chunkText = '';
                            try {
                                chunkText = chunk?.text || '';
                            } catch {
                                chunkText = '';
                            }
                            if (!chunkText && Array.isArray(chunk?.candidates?.[0]?.content?.parts)) {
                                chunkText = chunk.candidates[0].content.parts
                                    .filter(p => typeof p?.text === 'string' && !p.thought)
                                    .map(p => p.text)
                                    .join('');
                            }
                            if (chunkText) {
                                // 途中再開パス (passIndex > 0) の先頭で末尾スニペットの重複があれば除去
                                if (passIndex > 0 && chunkText && accumulatedText.length > 100) {
                                    accumulatedText += chunkText;
                                } else {
                                    accumulatedText += chunkText;
                                }
                                if (accumulatedText.length - lastReportedLength >= 1500) {
                                    lastReportedLength = accumulatedText.length;
                                    if (onProgress) {
                                        onProgress(`${passLabel} (現在 ${accumulatedText.length.toLocaleString()} 文字生成済み)...`, turnCount + 1);
                                    }
                                }
                            }
                            if (chunk?.usageMetadata) {
                                passUsage = chunk.usageMetadata;
                            }
                        }
                    } finally {
                        if (idleTimer) clearTimeout(idleTimer);
                    }
                })();

                await streamPromise;
                if (passUsage) {
                    totalPromptTokens += (passUsage.promptTokenCount || 0);
                    totalCandidateTokens += (passUsage.candidatesTokenCount || 0);
                }
            };

            // 初回ストリーミング生成（万が一 0 文字のまま失敗した場合は1回リトライ）
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await runStreamingPass(
                        synthesisPrompt,
                        'ダッシュボード構築中',
                        0
                    );
                    if (accumulatedText.trim().length > 0) break;
                } catch (streamErr) {
                    console.warn(`[MCP Chat] ⚠️ Stream pass 0 interrupted at ${accumulatedText.length} chars: ${streamErr.message}`);
                    if (streamErr.message.includes('キャンセル')) throw streamErr;
                    if (accumulatedText.trim().length > 200) {
                        // 途中まで生成されたHTMLがバッファに残っているため、破棄せずにそのまま下の自動再開（Auto-Resume）ループへ進む！
                        console.log(`[MCP Chat] 💾 Preserving ${accumulatedText.length} chars of partial output in checkpoint buffer for auto-resume.`);
                        break;
                    }
                    if (attempt === 0) {
                        if (onProgress) onProgress('⚠️ 応答待機タイムアウトを検知。ストリーミング接続を再試行中...', turnCount + 1);
                    }
                }
            }

            // チェックポイント自動再開（Auto-Resume）ハーネス:
            // ストリームが途中で切れた場合や MAX_OUTPUT_TOKENS に達して ```html が未完結の場合、
            // サーバー内バッファ (accumulatedText) の末尾から続きを自動生成して結合する（最大3回）
            const MAX_CONTINUATION_PASSES = 3;
            for (let contPass = 1; contPass <= MAX_CONTINUATION_PASSES; contPass++) {
                if (!hasUnclosedHtmlBlock(accumulatedText)) {
                    break;
                }
                console.log(`[MCP Chat] 🔄 Auto-Resume Pass ${contPass}/${MAX_CONTINUATION_PASSES}: HTML block is incomplete (${accumulatedText.length} chars saved in buffer). Resuming from checkpoint...`);
                if (onProgress) {
                    onProgress(`🔄 途中までの生成データ (${accumulatedText.length.toLocaleString()} 文字) から自動再開中 (${contPass}/${MAX_CONTINUATION_PASSES})...`, turnCount + 1);
                }

                const tailSnippet = accumulatedText.slice(-600);
                const beforeLen = accumulatedText.length;
                const resumeContents = [
                    { role: 'user', parts: [{ text: synthesisPrompt }] },
                    { role: 'model', parts: [{ text: `... (中略: 先頭から ${accumulatedText.length} 文字出力済み) ...\n${tailSnippet}` }] },
                    {
                        role: 'user',
                        parts: [{
                            text: `直前のあなたのHTMLダッシュボード出力は途中で中断されました（現在 ${accumulatedText.length} 文字までサーバーに保存されています）。\n最初からやり直さず、上記の末尾文字列:\n\`\`\`\n${tailSnippet.slice(-200)}\n\`\`\`\nの直後の文字から、重複させずに残りのHTML/SVG/scriptタグおよび閉じコードブロック（\`\`\`）を最後まで出力して完結させてください。前置きや挨拶は一切不要です。`
                        }]
                    }
                ];

                try {
                    await runStreamingPass(
                        resumeContents,
                        `ダッシュボード自動再開中 (${contPass}回目)`,
                        contPass
                    );
                    // もしモデルが再開部分で ```html を再出力してしまった場合は先頭の ```html を除去してシームレスに連結
                    const newlyAdded = accumulatedText.slice(beforeLen);
                    const cleanedAddition = newlyAdded.replace(/^\s*```(?:html)?\r?\n?/i, '');
                    accumulatedText = accumulatedText.slice(0, beforeLen) + cleanedAddition;
                    console.log(`[MCP Chat] ✅ Auto-Resume Pass ${contPass} added ${cleanedAddition.length} chars (Total: ${accumulatedText.length} chars).`);
                } catch (resumeErr) {
                    console.warn(`[MCP Chat] ⚠️ Auto-Resume Pass ${contPass} interrupted (${resumeErr.message}). Retained ${accumulatedText.length} chars.`);
                    if (resumeErr.message.includes('キャンセル')) throw resumeErr;
                }
            }

            finalResponseText = accumulatedText;
            if (totalPromptTokens > 0 || totalCandidateTokens > 0) {
                synthesizedUsageMetadata = {
                    promptTokenCount: totalPromptTokens,
                    candidatesTokenCount: totalCandidateTokens,
                    totalTokenCount: totalPromptTokens + totalCandidateTokens
                };
            }
            console.log(`[MCP Chat] Streaming synthesis completed. Final text length: ${finalResponseText?.length || 0}`);
        } catch (synthErr) {
            console.error('[MCP Chat] Synthesis fallback error:', synthErr.message);
        }
    }

    // 最終セーフティネット: 万が一合成すら失敗しても、取得データを要約して絶対に空文字にしない
    if (!finalResponseText && artifacts.length > 0) {
        finalResponseText = `### データ取得完了\n\n${artifacts.length}件のMCPツール実行が完了しました。取得データは以下の通りです:\n\n` + 
            artifacts.map((a, i) => `**[${i+1}] ${a.tool}**\n\`\`\`json\n${JSON.stringify(a.result, null, 2).substring(0, 1000)}\n\`\`\``).join('\n\n');
    }

    // コードブロック自動修復ハーネス: トークン切れ等で未完結の ```html がある場合、安全に閉じる
    if (finalResponseText && typeof finalResponseText === 'string') {
        const lastHtmlMarker = finalResponseText.lastIndexOf('```html');
        if (lastHtmlMarker !== -1) {
            const afterHtml = finalResponseText.substring(lastHtmlMarker + 7);
            if (!afterHtml.includes('```')) {
                console.warn('[MCP Chat] ⚠️ Detected unclosed ```html block. Auto-repairing code block...');
                let repaired = finalResponseText;
                const scriptOpens = (afterHtml.match(/<script\b[^>]*>/gi) || []).length;
                const scriptCloses = (afterHtml.match(/<\/script>/gi) || []).length;
                if (scriptOpens > scriptCloses) {
                    repaired += '\n// [Auto-repaired unclosed script by harness]\n</script>';
                }
                if (!afterHtml.includes('</body>')) {
                    repaired += '\n</body>';
                }
                if (!afterHtml.includes('</html>')) {
                    repaired += '\n</html>';
                }
                repaired += '\n```\n';
                finalResponseText = repaired;
            }
        }
    }

    const usageMetadata = synthesizedUsageMetadata || interaction?.usage || interaction?.usage_metadata || interaction?.usageMetadata || null;

    return {
        reply: finalResponseText,
        artifacts: artifacts,
        usageMetadata: usageMetadata,
        model: modelName,
        durationSeconds: Math.max(1, Math.round((Date.now() - workflowStartTime) / 1000)),
        interactionId: currentInteractionId,
        environmentId: currentEnvironmentId
    };
}

/**
 * バックグラウンドで非同期タスクを実行し、DB を更新する関数
 */
async function processTaskInBackground(taskId, { user, message, previous_interaction_id, environment_id, req, pipelineDomain, model }) {
    console.log(`[MCP Tasks] Starting background execution for task: ${taskId} (Domain: ${pipelineDomain || 'auto'}, Model: ${model || 'default'})`);

    const checkCancelled = async () => {
        return new Promise((resolve) => {
            db.get("SELECT status FROM mcp_tasks WHERE id = ?", [taskId], (err, row) => {
                if (err || !row) return resolve(false);
                resolve(row.status === 'cancelled');
            });
        });
    };

    const updateProgress = (progressMsg, turn) => {
        db.run(
            "UPDATE mcp_tasks SET status = 'running', progress_message = ?, current_turn = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [progressMsg, turn, taskId],
            (err) => {
                if (err) console.error(`[MCP Tasks] Progress update error for ${taskId}:`, err);
            }
        );
    };

    try {
        updateProgress('AIモデルを初期化中...', 0);

        const result = await executeMcpWorkflow({
            user,
            message,
            previous_interaction_id,
            environment_id,
            req,
            onProgress: updateProgress,
            checkCancelled,
            pipelineDomain,
            model
        });

        // 完了状態に更新
        const resultJson = JSON.stringify(result);
        db.run(
            "UPDATE mcp_tasks SET status = 'completed', progress_message = '完了しました', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [resultJson, taskId],
            (err) => {
                if (err) console.error(`[MCP Tasks] Completion save error for ${taskId}:`, err);
                else console.log(`[MCP Tasks] Task ${taskId} successfully completed.`);
            }
        );

    } catch (err) {
        console.error(`[MCP Tasks] Task ${taskId} execution failed:`, err);
        const isCancelled = err.message && err.message.includes('キャンセル');
        const finalStatus = isCancelled ? 'cancelled' : 'failed';
        const finalMsg = isCancelled ? 'キャンセルされました' : (err.message || 'タスク実行エラー');

        db.run(
            "UPDATE mcp_tasks SET status = ?, progress_message = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [finalStatus, finalMsg, err.message, taskId],
            (updateErr) => {
                if (updateErr) console.error(`[MCP Tasks] Error status save error for ${taskId}:`, updateErr);
            }
        );
    }
}

// ==========================================
// SEP-2663 Tasks 拡張機能 API (非同期・ステートレス)
// ==========================================

/**
 * GET /api/mcp/meta
 * クライアント側で利用可能なMCPサーバーおよびツールのメタ情報を取得
 */
const getMetaHandler = async (req, res) => {
    try {
        const metadata = await getMcpMetadata(req.user?.allowed_widgets || [], req.user);
        const globalGeminiModel = await db.getSetting('GEMINI_MODEL') || 'gemini-3.8-flash';
        const globalClaudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
        const configuredMcpModel = await db.getSetting('GEMINI_MCP_CHAT_MODEL');
        const configuredClaudeMcpModel = await db.getSetting('CLAUDE_MCP_CHAT_MODEL');
        const aiProvider = (await db.getSetting('AI_PROVIDER')) || 'gemini';
        const mcpAiProvider = (await db.getSetting('MCP_AI_PROVIDER')) || aiProvider;
        const defaultMcpModel = (configuredMcpModel && llmAdapter.isClaudeModel(configuredMcpModel))
            ? configuredMcpModel
            : (mcpAiProvider === 'claude' ? (configuredClaudeMcpModel || globalClaudeModel) : (configuredMcpModel || globalGeminiModel));
        res.json({
            ...metadata,
            userRole: req.user?.role || 'user',
            defaultModel: defaultMcpModel
        });
    } catch (err) {
        console.error("[MCP Meta] Failed to fetch metadata:", err);
        res.status(500).json({ error: 'Failed to fetch MCP metadata' });
    }
};

router.get('/meta', getMetaHandler);
router.get('/', (req, res, next) => {
    if (req.baseUrl && req.baseUrl.endsWith('/meta')) {
        return getMetaHandler(req, res);
    }
    next();
});

/**
 * POST /api/mcp/tasks
 * 非同期タスクの受付（即座に HTTP 202 Accepted と taskId を返却）
 */
const createTaskHandler = async (req, res) => {
    try {
        const { message, previous_interaction_id, environment_id, pipelineDomain, model } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const taskId = crypto.randomUUID();
        const userId = req.user?.id || null;

        db.run(
            `INSERT INTO mcp_tasks (id, user_id, prompt, status, progress_message, current_turn) VALUES (?, ?, ?, 'pending', 'タスクを受け付けました', 0)`,
            [taskId, userId, message],
            (err) => {
                if (err) {
                    console.error("[MCP Tasks] Failed to create task record:", err);
                    return res.status(500).json({ error: 'Failed to create task' });
                }

                // 即座に 202 Accepted を返却（CloudFront 60秒タイムアウトの完全根絶）
                res.status(202).json({
                    taskId: taskId,
                    status: 'pending',
                    message: 'Task accepted successfully'
                });

                // バックグラウンド非同期処理の開始
                processTaskInBackground(taskId, {
                    user: req.user,
                    message,
                    previous_interaction_id,
                    environment_id,
                    req,
                    pipelineDomain,
                    model
                });
            }
        );
    } catch (err) {
        console.error("[MCP Tasks] Create error:", err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
};

router.post('/tasks', createTaskHandler);

const getTaskHandler = (req, res) => {
    const { taskId } = req.params;

    db.get("SELECT * FROM mcp_tasks WHERE id = ?", [taskId], (err, row) => {
        if (err) {
            console.error(`[MCP Tasks] Fetch error for ${taskId}:`, err);
            return res.status(500).json({ error: 'Failed to fetch task status' });
        }

        if (!row) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 所有者チェック (req.user が存在し、本人のタスクか管理者か)
        if (req.user && row.user_id && row.user_id !== req.user.id) {
            const isAdmin = req.user.role === 'admin' || (req.user.allowed_actions && req.user.allowed_actions.includes('*'));
            if (!isAdmin) {
                return res.status(403).json({ error: 'Access denied to this task' });
            }
        }

        let parsedResult = null;
        if (row.result) {
            try {
                parsedResult = JSON.parse(row.result);
            } catch (e) {
                console.error(`[MCP Tasks] Result parse error for ${taskId}:`, e);
            }
        }

        res.json({
            taskId: row.id,
            status: row.status, // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
            progress: row.progress_message,
            currentTurn: row.current_turn,
            result: parsedResult,
            error: row.error,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        });
    });
};

const cancelTaskHandler = (req, res) => {
    const { taskId } = req.params;

    db.run(
        "UPDATE mcp_tasks SET status = 'cancelled', progress_message = 'ユーザーによりキャンセルされました', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [taskId],
        function (err) {
            if (err) {
                console.error(`[MCP Tasks] Cancel error for ${taskId}:`, err);
                return res.status(500).json({ error: 'Failed to cancel task' });
            }
            res.json({ taskId, status: 'cancelled', message: 'Task cancelled successfully' });
        }
    );
};

router.get('/tasks/:taskId', getTaskHandler);
router.post('/tasks/:taskId/cancel', cancelTaskHandler);

// Aliases for /api/mcp/tasks/:taskId
router.get('/:taskId', (req, res, next) => {
    if (req.params.taskId === 'tasks') return next();
    getTaskHandler(req, res);
});
router.post('/:taskId/cancel', cancelTaskHandler);

// ==========================================
// 従来の POST / (同期モード - 後方互換性維持)
// ==========================================
router.post('/', async (req, res) => {
    // もし /api/mcp/tasks にマウントされた場合はタスク作成ハンドラへ委譲
    if (req.baseUrl && req.baseUrl.endsWith('/tasks')) {
        return createTaskHandler(req, res);
    }

    try {
        const { message, previous_interaction_id, environment_id, model, pipelineDomain } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const result = await executeMcpWorkflow({
            user: req.user,
            message,
            previous_interaction_id,
            environment_id,
            model,
            pipelineDomain,
            req
        });

        res.json(result);

    } catch (error) {
        console.error("MCP Chat Error:", error);
        res.status(500).json({ error: error.message || 'An error occurred during MCP Chat' });
    }
});

module.exports = router;
module.exports.DEFAULT_MCP_CHAT_SYSTEM_INSTRUCTION = DEFAULT_MCP_CHAT_SYSTEM_INSTRUCTION;
