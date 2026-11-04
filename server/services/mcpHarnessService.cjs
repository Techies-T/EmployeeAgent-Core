const fs = require('fs');
const path = require('path');
const db = require('../db.cjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const HARNESS_YAML_PATH = path.join(DATA_DIR, 'mcp-harness.yaml');

const DEFAULT_HARNESS_CONFIG = {
    version: '1.1',
    gateway_mode_default: 'zta_gateway',
    public_direct_guard: '外部の公開情報MCPサーバー(Direct接続)へクエリを送信する際、社内の機密情報・顧客名・個人名(PII)・内部財務数値を絶対に引数に含めないでください。',
    domains: {
        knowledge_base: {
            category: 'ナレッジベース',
            icon: '📚',
            isBuiltInKnowledge: true,
            match_patterns: ['knowledge', '/api/mcp/knowledge'],
            trigger_keywords: ['ナレッジ', 'マニュアル', '社内規程', 'インプットトークン', 'アウトプットトークン', 'トークン', 'token', '著者', 'author', '投稿数', '記事', 'クロス集計', 'crosstab'],
            routing_instruction: '著者別・期間別の記事投稿数やインプット/アウトプットトークンのクロス集計では、必ず Knowledge Base MCP を呼び出してください。'
        },
        npb_baseball: {
            category: 'プロ野球データ分析 (球団・選手DB)',
            icon: '⚾',
            match_patterns: ['npb', 'baseball', 'mariadb', '/mcp/mariadb'],
            trigger_keywords: ['野球', 'npb', '選手', '打率', '防御率', 'ホームラン', '本塁打', '打点', 'セ・リーグ', 'パ・リーグ', '球団', '阪神', '巨人', 'ソフトバンク', '日本ハム', '成績', '年俸'],
            routing_instruction: 'NPBデータベースの照会では年度(2026等)とリーグ・球団名を確認してSQLを実行してください。ロールに球団スコープ(department_pod)や禁止カラム制限がある場合は厳守してください。'
        },
        digital_agency: {
            category: '行政手続・公開統計',
            icon: '🏛️',
            match_patterns: ['行政', 'procedures', '/mcp/admin-procedures', 'estat'],
            trigger_keywords: ['行政', '手続', 'デジタル庁', '申請', 'オンライン化', '法令', '省庁', '統計', '届出'],
            routing_instruction: 'デジタル庁・行政手続データの照会では対象省庁および手続種別を確認して集計してください。'
        },
        hr_database: {
            category: '人事・組織データベース',
            icon: '👔',
            match_patterns: ['人事', 'hr', 'personnel', '/mcp/hr'],
            trigger_keywords: ['人事', '社員', '従業員', '部署', '評価', '異動', 'スキル', 'タレント', '人員', '給与', '賞与'],
            routing_instruction: '人事データの照会ではユーザーのロール権限（全社許可または所属部門限定）に従い、許可されたテーブル・カラムのみを参照してください。'
        },
        sales_forecast: {
            category: '売上・経営データ分析',
            icon: '📊',
            match_patterns: ['sales', '売上', 'forecast', 'erp', '/mcp/sales'],
            trigger_keywords: ['売上', '見込み', 'Q1', 'Q2', '予算', '達成率', 'パイプライン', '商談', '受注', '利益'],
            routing_instruction: '売上見込みや予実分析では対象期間（2026年Q1等）と事業ドメインを明確にして集計してください。'
        },
        catalog: {
            category: 'データカタログ・GenUIメタ情報',
            icon: '📑',
            match_patterns: ['catalog', '/mcp/catalog'],
            trigger_keywords: ['カタログ', 'メタデータ', 'スキーマ一覧', 'テーブル定義'],
            routing_instruction: 'データカタログMCPを参照してスキーマやUI定義を確認します。'
        },
        google_workspace: {
            category: 'Google Workspace (予定・Todo)',
            icon: '📅',
            match_patterns: ['workspace', 'calendar', 'todo', 'tasks', 'gmail', 'google'],
            trigger_keywords: ['カレンダー', '予定', 'ミーティング', '会議', 'todo', 'タスク', 'gmail', 'スケジュール'],
            routing_instruction: 'Google Workspace の予定・タスク操作を行います。タイムゾーンは Asia/Tokyo を標準とします。'
        },
        local_ai: {
            category: 'ローカルAI推論',
            icon: '🤖',
            isBuiltInGemma: true,
            match_patterns: ['gemma', '/api/mcp/gemma'],
            trigger_keywords: ['gemma', 'ローカルai', 'ローカル推論'],
            routing_instruction: 'ローカルAI推論サーバーを呼び出します。'
        }
    }
};

/**
 * Serialize config object into clean, human-editable YAML format
 */
function serializeToYaml(config) {
    const lines = [
        '# ============================================================================',
        '# Employee Agent Core - Dynamic MCP Routing & Security Harness (mcp-harness.yaml)',
        '# System Settings から直接編集・0秒ホットリロード可能（コンテナ再デプロイ不要）',
        '# ============================================================================',
        `version: "${config.version || '1.1'}"`,
        `gateway_mode_default: "${config.gateway_mode_default || 'zta_gateway'}"`,
        `public_direct_guard: ${JSON.stringify(config.public_direct_guard || DEFAULT_HARNESS_CONFIG.public_direct_guard)}`,
        '',
        'domains:'
    ];

    const domains = config.domains || DEFAULT_HARNESS_CONFIG.domains;
    for (const [domainKey, d] of Object.entries(domains)) {
        lines.push(`  ${domainKey}:`);
        lines.push(`    category: ${JSON.stringify(d.category || domainKey)}`);
        lines.push(`    icon: ${JSON.stringify(d.icon || '⚡')}`);
        if (d.isBuiltInKnowledge) lines.push(`    isBuiltInKnowledge: true`);
        if (d.isBuiltInGemma) lines.push(`    isBuiltInGemma: true`);
        lines.push(`    match_patterns: ${JSON.stringify(Array.isArray(d.match_patterns) ? d.match_patterns : [])}`);
        lines.push(`    trigger_keywords: ${JSON.stringify(Array.isArray(d.trigger_keywords) ? d.trigger_keywords : [])}`);
        lines.push(`    routing_instruction: ${JSON.stringify(d.routing_instruction || '')}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Parse YAML text (supports our structured YAML format as well as JSON)
 */
function parseHarnessYaml(yamlText) {
    if (!yamlText || typeof yamlText !== 'string') {
        return JSON.parse(JSON.stringify(DEFAULT_HARNESS_CONFIG));
    }

    const trimmed = yamlText.trim();
    if (trimmed.startsWith('{')) {
        return JSON.parse(trimmed);
    }

    const result = {
        version: '1.1',
        gateway_mode_default: 'zta_gateway',
        public_direct_guard: DEFAULT_HARNESS_CONFIG.public_direct_guard,
        domains: {}
    };

    let inDomains = false;
    let currentDomainKey = null;

    const parseScalarOrJson = (valStr) => {
        const s = valStr.trim();
        if (!s) return '';
        if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
            try {
                return JSON.parse(s);
            } catch (e) {
                // fallback below
            }
        }
        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
            return s.slice(1, -1);
        }
        if (s === 'true') return true;
        if (s === 'false') return false;
        return s;
    };

    const rawLines = yamlText.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const cleanLine = line.replace(/^\s*#.*$/, '');
        if (!cleanLine.trim()) continue;

        const indent = line.match(/^\s*/)[0].length;
        const content = cleanLine.trim();

        if (indent === 0) {
            if (content === 'domains:') {
                inDomains = true;
                currentDomainKey = null;
                continue;
            }
            const kvMatch = content.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
            if (kvMatch) {
                inDomains = false;
                const [, k, v] = kvMatch;
                result[k] = parseScalarOrJson(v);
            }
        } else if (inDomains && indent === 2 && content.endsWith(':')) {
            currentDomainKey = content.slice(0, -1).trim();
            if (!result.domains[currentDomainKey]) {
                result.domains[currentDomainKey] = {
                    category: currentDomainKey,
                    icon: '⚡',
                    match_patterns: [],
                    trigger_keywords: [],
                    routing_instruction: ''
                };
            }
        } else if (inDomains && currentDomainKey && indent >= 4) {
            const kvMatch = content.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
            if (kvMatch) {
                const [, k, v] = kvMatch;
                result.domains[currentDomainKey][k] = parseScalarOrJson(v);
            }
        }
    }

    if (Object.keys(result.domains).length === 0) {
        throw new Error('YAML 内に有効な domains セクションが見つかりません。');
    }

    return result;
}

let cachedHarnessConfig = null;
let cachedHarnessYaml = null;
let lastReloadedAt = null;

async function initHarness() {
    try {
        if (fs.existsSync(HARNESS_YAML_PATH)) {
            const yamlText = fs.readFileSync(HARNESS_YAML_PATH, 'utf8');
            cachedHarnessConfig = parseHarnessYaml(yamlText);
            cachedHarnessYaml = yamlText;
            lastReloadedAt = new Date().toISOString();
            return cachedHarnessConfig;
        }
        const dbYaml = await db.getSetting('MCP_HARNESS_YAML');
        if (dbYaml) {
            cachedHarnessConfig = parseHarnessYaml(dbYaml);
            cachedHarnessYaml = dbYaml;
            try {
                fs.writeFileSync(HARNESS_YAML_PATH, dbYaml, 'utf8');
            } catch (e) { /* ignore fs write warning */ }
            lastReloadedAt = new Date().toISOString();
            return cachedHarnessConfig;
        }
    } catch (err) {
        console.warn('[MCP Harness] Failed to load custom harness, falling back to default:', err.message);
    }

    cachedHarnessConfig = JSON.parse(JSON.stringify(DEFAULT_HARNESS_CONFIG));
    cachedHarnessYaml = serializeToYaml(cachedHarnessConfig);
    lastReloadedAt = new Date().toISOString();
    try {
        fs.writeFileSync(HARNESS_YAML_PATH, cachedHarnessYaml, 'utf8');
    } catch (e) { /* ignore */ }
    return cachedHarnessConfig;
}

function getHarnessConfigSync() {
    if (!cachedHarnessConfig) {
        try {
            if (fs.existsSync(HARNESS_YAML_PATH)) {
                const yamlText = fs.readFileSync(HARNESS_YAML_PATH, 'utf8');
                cachedHarnessConfig = parseHarnessYaml(yamlText);
                cachedHarnessYaml = yamlText;
                lastReloadedAt = new Date().toISOString();
                return cachedHarnessConfig;
            }
        } catch (e) { /* fallback */ }
        cachedHarnessConfig = JSON.parse(JSON.stringify(DEFAULT_HARNESS_CONFIG));
        cachedHarnessYaml = serializeToYaml(cachedHarnessConfig);
        lastReloadedAt = new Date().toISOString();
    }
    return cachedHarnessConfig;
}

async function getHarnessInfo() {
    await initHarness();
    return {
        yaml: cachedHarnessYaml || serializeToYaml(cachedHarnessConfig),
        config: cachedHarnessConfig,
        filePath: HARNESS_YAML_PATH,
        lastReloadedAt: lastReloadedAt || new Date().toISOString()
    };
}

async function saveAndHotReloadHarness(yamlText) {
    const parsed = parseHarnessYaml(yamlText);
    const normalizedYaml = yamlText.trim() ? yamlText : serializeToYaml(parsed);

    fs.writeFileSync(HARNESS_YAML_PATH, normalizedYaml, 'utf8');
    await db.setSetting('MCP_HARNESS_YAML', normalizedYaml);

    cachedHarnessConfig = parsed;
    cachedHarnessYaml = normalizedYaml;
    lastReloadedAt = new Date().toISOString();

    console.log(`[MCP Harness] ⚡ Hot-reloaded mcp-harness.yaml (${Object.keys(parsed.domains || {}).length} domains active) at ${lastReloadedAt}`);
    return {
        success: true,
        yaml: normalizedYaml,
        config: parsed,
        filePath: HARNESS_YAML_PATH,
        lastReloadedAt
    };
}

async function resetHarnessToDefault() {
    const defaultCfg = JSON.parse(JSON.stringify(DEFAULT_HARNESS_CONFIG));
    const yamlText = serializeToYaml(defaultCfg);
    return await saveAndHotReloadHarness(yamlText);
}

/**
 * Classify an MCP server connection using the hot-reloaded YAML harness
 */
function classifyServerByHarness(conn) {
    const cfg = getHarnessConfigSync();
    const domains = cfg.domains || DEFAULT_HARNESS_CONFIG.domains;
    const explicitDomain = conn?.domain_key;

    if (explicitDomain && domains[explicitDomain]) {
        const d = domains[explicitDomain];
        return {
            domain: explicitDomain,
            icon: d.icon || '⚡',
            category: d.category || explicitDomain,
            isBuiltInKnowledge: Boolean(d.isBuiltInKnowledge),
            isBuiltInGemma: Boolean(d.isBuiltInGemma),
            routingInstruction: d.routing_instruction || ''
        };
    }

    const nameLower = (conn?.name || '').toLowerCase();
    const urlLower = (conn?.endpoint_url || '').toLowerCase();

    for (const [domainKey, d] of Object.entries(domains)) {
        const patterns = Array.isArray(d.match_patterns) ? d.match_patterns : [];
        const matched = patterns.some(p => {
            const pLower = String(p).toLowerCase();
            return nameLower.includes(pLower) || urlLower.includes(pLower);
        });
        if (matched) {
            return {
                domain: domainKey,
                icon: d.icon || '⚡',
                category: d.category || domainKey,
                isBuiltInKnowledge: Boolean(d.isBuiltInKnowledge),
                isBuiltInGemma: Boolean(d.isBuiltInGemma),
                routingInstruction: d.routing_instruction || ''
            };
        }
    }

    return {
        domain: 'general',
        icon: conn?.connection_mode === 'direct_public' ? '🌐' : '⚡',
        category: conn?.connection_mode === 'direct_public' ? '公開データ (Direct)' : 'システム・汎用',
        routingInstruction: ''
    };
}

/**
 * Match prompt text against YAML domain trigger_keywords
 */
function matchDomainsForPrompt(promptText) {
    const cfg = getHarnessConfigSync();
    const domains = cfg.domains || DEFAULT_HARNESS_CONFIG.domains;
    const lowerPrompt = String(promptText || '').toLowerCase();
    const matched = new Set();

    for (const [domainKey, d] of Object.entries(domains)) {
        const keywords = Array.isArray(d.trigger_keywords) ? d.trigger_keywords : [];
        if (keywords.some(kw => lowerPrompt.includes(String(kw).toLowerCase()))) {
            matched.add(domainKey);
        }
    }
    return matched;
}

function getHarnessYamlText() {
    getHarnessConfigSync();
    return cachedHarnessYaml || serializeToYaml(cachedHarnessConfig);
}

module.exports = {
    DEFAULT_HARNESS_CONFIG,
    HARNESS_YAML_PATH,
    HARNESS_FILE_PATH: HARNESS_YAML_PATH,
    initHarness,
    initMcpHarness: initHarness,
    getHarnessConfigSync,
    getHarnessConfig: getHarnessConfigSync,
    getHarnessYamlText,
    getHarnessInfo,
    saveAndHotReloadHarness,
    resetHarnessToDefault,
    classifyServerByHarness,
    matchDomainsForPrompt
};
