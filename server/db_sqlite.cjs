const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const fs = require('fs');
const dataDir = path.resolve(__dirname, '../data');
const dbPath = fs.existsSync(dataDir)
    ? path.join(dataDir, 'database.sqlite')
    : path.resolve(__dirname, 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run("PRAGMA journal_mode = WAL;");
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    access_token TEXT,
    refresh_token TEXT,
    last_deep_research_at DATETIME,
    deep_research_date TEXT,
    deep_research_count INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    deep_research_enabled INTEGER DEFAULT 0,
    token_expiry INTEGER,
    current_room TEXT DEFAULT 'open-space',
    status_text TEXT DEFAULT 'Active',
    is_remote INTEGER DEFAULT 0,
    assistant_work_start TEXT DEFAULT '09:00',
    assistant_work_end TEXT DEFAULT '17:30',
    assistant_break_start TEXT DEFAULT '12:00',
    assistant_break_end TEXT DEFAULT '13:00',
    assistant_meeting_buffer INTEGER DEFAULT 30,
    assistant_prompt TEXT,
    native_language TEXT DEFAULT 'ja',
    last_active_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

    // Migration for existing table
    db.run("ALTER TABLE users ADD COLUMN access_token TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN refresh_token TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN last_deep_research_at DATETIME", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN deep_research_date TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN deep_research_count INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN deep_research_enabled INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN token_expiry INTEGER", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN current_room TEXT DEFAULT 'open-space'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT 'Active'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN is_remote INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_work_start TEXT DEFAULT '09:00'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_work_end TEXT DEFAULT '17:30'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_meeting_buffer INTEGER DEFAULT 30", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_break_start TEXT DEFAULT '12:00'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_break_end TEXT DEFAULT '13:00'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN assistant_prompt TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN native_language TEXT DEFAULT 'ja'", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE users ADD COLUMN last_active_at TEXT", (err) => {
        // Ignore error if column exists
    });

    db.run(`CREATE TABLE IF NOT EXISTS user_passkeys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credential_id TEXT UNIQUE,
        public_key TEXT NOT NULL,
        algorithm INTEGER DEFAULT -7,
        sign_count INTEGER DEFAULT 0,
        public_key_alg INTEGER DEFAULT -7,
        counter INTEGER DEFAULT 0,
        transports TEXT,
        device_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
    )`);
    db.run("ALTER TABLE user_passkeys ADD COLUMN credential_id TEXT", () => {});
    db.run("ALTER TABLE user_passkeys ADD COLUMN algorithm INTEGER DEFAULT -7", () => {});
    db.run("ALTER TABLE user_passkeys ADD COLUMN sign_count INTEGER DEFAULT 0", () => {});

    db.run(`CREATE TABLE IF NOT EXISTS deep_research_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        query_text TEXT,
        status TEXT,
        result_link TEXT,
        pod_id TEXT,
        selected_article_ids TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS deep_research_workflows (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        query_text TEXT,
        pipeline_type TEXT,
        status TEXT,
        plan_text TEXT,
        report_text TEXT,
        generated_payload TEXT,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        pod_id TEXT,
        workflow_definition_id TEXT,
        selected_article_ids TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS invitations (
        email TEXT PRIMARY KEY,
        invited_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS deep_research_workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        research_model TEXT,
        research_prompt TEXT,
        output_type TEXT,
        output_model TEXT,
        output_prompt TEXT,
        folder_id TEXT,
        pod_id TEXT,
        reference_knowledge INTEGER DEFAULT 0,
        reference_pod_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS published_reports (
        id TEXT PRIMARY KEY,
        title TEXT,
        content TEXT,
        mime_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS rag_files (
    drive_file_id TEXT PRIMARY KEY,
    gemini_file_uri TEXT,
    folder_id TEXT,
    file_name TEXT,
    mime_type TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_hash TEXT
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS rag_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_text TEXT UNIQUE,
    usage_count INTEGER DEFAULT 1,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);


    // Migration for rag_files
    db.run("ALTER TABLE rag_files ADD COLUMN mime_type TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE rag_files ADD COLUMN folder_id TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE rag_files ADD COLUMN file_name TEXT", (err) => {
        // Ignore error if column exists
    });

    // User Preferences (Window State & Personal Chat Presets)
    db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INTEGER PRIMARY KEY,
        window_state TEXT,
        chat_presets TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run("ALTER TABLE user_preferences ADD COLUMN chat_presets TEXT", () => {});

    // Memos (Stickies)
    db.run(`CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        content TEXT,
        color TEXT,
        x INTEGER,
        y INTEGER,
        width INTEGER,
        height INTEGER,
        z_index INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Knowledge Base Articles
    db.run(`CREATE TABLE IF NOT EXISTS knowledge_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        tags TEXT,
        author_id INTEGER,
        token_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        pod_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(author_id) REFERENCES users(id)
    )`);

    // Migration for knowledge_articles token_count
    db.run("ALTER TABLE knowledge_articles ADD COLUMN token_count INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });

    db.run("ALTER TABLE deep_research_workflows ADD COLUMN workflow_definition_id TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE knowledge_articles ADD COLUMN input_tokens INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
        db.run(`UPDATE knowledge_articles SET input_tokens = CAST(token_count * 0.2 AS INTEGER), output_tokens = CAST(token_count * 0.8 AS INTEGER) WHERE input_tokens = 0 AND output_tokens = 0 AND token_count > 0;`);
    });
    db.run("ALTER TABLE knowledge_articles ADD COLUMN output_tokens INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });

    // External Skills
    db.run(`CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon_url TEXT,
        entrypoint_url TEXT NOT NULL,
        manifest_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // MCP Servers (Multiple)
    db.run(`CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        token_url TEXT,
        client_id TEXT,
        client_secret TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run("UPDATE mcp_servers SET endpoint_url = REPLACE(endpoint_url, 'https://localhost', 'http://localhost'), token_url = REPLACE(token_url, 'https://localhost', 'http://localhost') WHERE endpoint_url LIKE 'https://localhost%'");

    // MCP Tasks (SEP-2663 Async Stateless Tasks)
    db.run(`CREATE TABLE IF NOT EXISTS mcp_tasks (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        server_id TEXT,
        prompt TEXT,
        status TEXT NOT NULL,
        progress_message TEXT,
        current_turn INTEGER DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS dm_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        sender_type TEXT DEFAULT 'user',
        text TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add is_read column to existing dm_messages for migration
    db.run("ALTER TABLE dm_messages ADD COLUMN is_read INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });

    // Add pod_id column to existing tables for logical separation
    db.run("ALTER TABLE knowledge_articles ADD COLUMN pod_id TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE deep_research_workflow_definitions ADD COLUMN pod_id TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE deep_research_workflows ADD COLUMN pod_id TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE deep_research_history ADD COLUMN pod_id TEXT", (err) => {
        // Ignore error if column exists
    });

    db.run("ALTER TABLE deep_research_workflow_definitions ADD COLUMN reference_knowledge INTEGER DEFAULT 0", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE deep_research_workflow_definitions ADD COLUMN reference_pod_id TEXT", (err) => {
        // Ignore error if column exists
    });

    db.run("ALTER TABLE deep_research_workflows ADD COLUMN selected_article_ids TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE deep_research_history ADD COLUMN selected_article_ids TEXT", (err) => {
        // Ignore error if column exists
    });
    db.run("ALTER TABLE rag_files ADD COLUMN local_cache_path TEXT", (err) => {
        // Ignore error if column exists
    });

    // Execute autoActivate only after all schema creation/migration statements in db.serialize have finished
    db.run("SELECT 1", () => {
        autoActivate();
    });
    }); // End db.serialize
}

const { encrypt, decrypt } = require('./crypto.cjs');

// Helper to check if a setting key is sensitive
const isSensitiveKey = (key) => {
    return key.includes('SECRET') || key.includes('KEY') || key.includes('TOKEN');
};

// Helper to get a setting
db.getSetting = (key) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT value FROM settings WHERE key = ?", [key], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);

            // Decrypt sensible fields
            if (isSensitiveKey(key) && row.value) {
                try {
                    resolve(decrypt(row.value));
                } catch (e) {
                    console.error(`Failed to decrypt ${key}, returning raw value`);
                    resolve(row.value);
                }
            } else {
                resolve(row.value);
            }
        });
    });
};

// Helper to set a setting
db.setSetting = (key, value) => {
    return new Promise((resolve, reject) => {
        // Encrypt sensible fields
        let finalValue = value;
        if (value && isSensitiveKey(key)) {
            finalValue = encrypt(value);
        }

        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, finalValue], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

// Auto-Activation Logic
async function autoActivate() {
    try {
        console.log("DEBUG: autoActivate started!");
        const existingPolicies = await db.getSetting('RBAC_POLICIES');
        if (!existingPolicies) {
            console.log('DEBUG: Initializing default RBAC policies...');
            const defaultPolicies = JSON.stringify({
                "admin": {
                    "label": "システム管理者 (Admin)",
                    "description": "全ウィジェット・全MCPサーバー・ナレッジベース(全Pod)・ZTA PDPに対する完全な管理権限",
                    "allowed_widgets": ["*"],
                    "allowed_models": ["*"],
                    "allowed_actions": ["*"],
                    "allowed_pods": ["*"],
                    "pod_scopes": { "*": "manage" }
                },
                "manager": {
                    "label": "マネージャー (Manager)",
                    "description": "部門・チーム管理者ロール。ノーマルチャット、MCPクライアント、およびナレッジベース(全Pod/所属部門Podの登録・運用)が可能",
                    "allowed_widgets": ["app:gemini", "app:mcp-chat", "app:knowledge-base"],
                    "allowed_models": ["*"],
                    "allowed_actions": ["action:manage_assistant_rules", "action:use_mcp_tools", "action:publish_knowledge"],
                    "allowed_pods": ["*", "public"],
                    "pod_scopes": { "*": "write", "public": "write" },
                    "widget_levels": { "gemini": "execute", "mcp-chat": "execute", "knowledge-base": "manage" }
                },
                "user": {
                    "label": "一般ユーザー (General_User)",
                    "description": "標準ユーザーロール。ノーマルチャット、許可されたMCPサーバー、およびナレッジベース(公開Pod/所属部門Podへの保存・参照)が可能",
                    "allowed_widgets": ["app:gemini", "app:mcp-chat", "app:knowledge-base"],
                    "allowed_models": ["model:gemini-flash", "model:claude-haiku", "model:claude-sonnet"],
                    "allowed_actions": ["action:use_mcp_tools", "action:publish_knowledge"],
                    "allowed_pods": ["public"],
                    "pod_scopes": { "public": "write" },
                    "widget_levels": { "gemini": "execute", "mcp-chat": "execute", "knowledge-base": "execute" }
                },
                "guest": {
                    "label": "ゲスト (Guest)",
                    "description": "外部・一時利用向けの最小権限ロール。ノーマルチャットおよび公開ナレッジベース(public Podの閲覧のみ)が利用可能",
                    "allowed_widgets": ["app:gemini", "app:knowledge-base"],
                    "allowed_models": ["model:gemini-flash"],
                    "allowed_actions": [],
                    "allowed_pods": ["public"],
                    "pod_scopes": { "public": "read" },
                    "widget_levels": { "gemini": "execute", "mcp-chat": "none", "knowledge-base": "read" }
                }
            });
            await db.setSetting('RBAC_POLICIES', defaultPolicies);
        } else {
            try {
                const policies = JSON.parse(existingPolicies);
                let updated = false;

                if (!policies.manager) {
                    policies.manager = {
                        "label": "マネージャー (Manager)",
                        "description": "部門・チーム管理者ロール。ノーマルチャット、MCPクライアント、およびナレッジベース(全Pod/所属部門Podの登録・運用)が可能",
                        "allowed_widgets": ["app:gemini", "app:mcp-chat", "app:knowledge-base"],
                        "allowed_models": ["*"],
                        "allowed_actions": ["action:manage_assistant_rules", "action:use_mcp_tools", "action:publish_knowledge"],
                        "allowed_pods": ["*", "public"],
                        "pod_scopes": { "*": "write", "public": "write" },
                        "widget_levels": { "gemini": "execute", "mcp-chat": "execute", "knowledge-base": "manage" }
                    };
                    updated = true;
                }

                if (!policies.user) {
                    policies.user = {
                        "label": "一般ユーザー (General_User)",
                        "description": "標準ユーザーロール。ノーマルチャット、許可されたMCPサーバー、およびナレッジベース(公開Pod/所属部門Podへの保存・参照)が可能",
                        "allowed_widgets": ["app:gemini", "app:mcp-chat", "app:knowledge-base"],
                        "allowed_models": ["model:gemini-flash", "model:claude-haiku", "model:claude-sonnet"],
                        "allowed_actions": ["action:use_mcp_tools", "action:publish_knowledge"],
                        "allowed_pods": ["public"],
                        "pod_scopes": { "public": "write" },
                        "widget_levels": { "gemini": "execute", "mcp-chat": "execute", "knowledge-base": "execute" }
                    };
                    updated = true;
                }

                if (!policies.guest) {
                    policies.guest = {
                        "label": "ゲスト (Guest)",
                        "description": "外部・一時利用向けの最小権限ロール。ノーマルチャットおよび公開ナレッジベース(public Podの閲覧のみ)が利用可能",
                        "allowed_widgets": ["app:gemini", "app:knowledge-base"],
                        "allowed_models": ["model:gemini-flash"],
                        "allowed_actions": [],
                        "allowed_pods": ["public"],
                        "pod_scopes": { "public": "read" },
                        "widget_levels": { "gemini": "execute", "mcp-chat": "none", "knowledge-base": "read" }
                    };
                    updated = true;
                }

                if (updated) {
                    console.log('DEBUG: Updating existing RBAC policies with core base roles (admin/manager/user/guest)...');
                    await db.setSetting('RBAC_POLICIES', JSON.stringify(policies));
                }
            } catch (err) {
                console.error("Failed to migrate RBAC policies:", err);
            }
        }

        console.log("DEBUG: Checking environment variables for auto-configuration...");
        const existingClientId = await db.getSetting('GOOGLE_CLIENT_ID');
        const envClientId = process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
        const envClientSecret = process.env.GOOGLE_CLIENT_SECRET;

        // Automatically configure DB if credentials are provided in env but missing in DB
        if ((!existingClientId || existingClientId === '') && envClientId && envClientSecret) {
            console.log('DEBUG: Auto-activating system based on Environment Variables...');
            await db.setSetting('GOOGLE_CLIENT_ID', envClientId);
            await db.setSetting('GOOGLE_CLIENT_SECRET', envClientSecret);
            console.log('DEBUG: Auto-activation of Google OAuth complete.');
        }

        // Additional environment variable auto-settings for YAML/Container deployments
        if (process.env.GEMINI_API_KEY) {
            const existingGemini = await db.getSetting('GEMINI_API_KEY');
            if (!existingGemini) {
                await db.setSetting('GEMINI_API_KEY', process.env.GEMINI_API_KEY);
                console.log('DEBUG: Auto-configured GEMINI_API_KEY from environment.');
            }
        }
        const envClaudeKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        if (envClaudeKey) {
            const existingClaude = await db.getSetting('CLAUDE_API_KEY');
            if (!existingClaude) {
                await db.setSetting('CLAUDE_API_KEY', envClaudeKey);
                console.log('DEBUG: Auto-configured CLAUDE_API_KEY from environment.');
            }
        }
        if (!(await db.getSetting('AI_PROVIDER'))) {
            await db.setSetting('AI_PROVIDER', process.env.AI_PROVIDER || 'gemini');
        }
        if (!(await db.getSetting('GEMINI_MODEL'))) {
            await db.setSetting('GEMINI_MODEL', process.env.GEMINI_MODEL || 'gemini-3.8-flash');
        }
        if (!(await db.getSetting('GEMINI_MCP_CHAT_MODEL'))) {
            await db.setSetting('GEMINI_MCP_CHAT_MODEL', process.env.GEMINI_MCP_CHAT_MODEL || 'gemini-3.8-flash');
        }
        if (!(await db.getSetting('CLAUDE_MODEL'))) {
            await db.setSetting('CLAUDE_MODEL', process.env.CLAUDE_MODEL || 'claude-sonnet-4-5');
        }
        if (!(await db.getSetting('CLAUDE_RESEARCH_MODEL'))) {
            await db.setSetting('CLAUDE_RESEARCH_MODEL', process.env.CLAUDE_RESEARCH_MODEL || 'claude-sonnet-4-5');
        }
        if (!(await db.getSetting('CLAUDE_HTML_SVG_MODEL'))) {
            await db.setSetting('CLAUDE_HTML_SVG_MODEL', process.env.CLAUDE_HTML_SVG_MODEL || 'claude-sonnet-4-5');
        }
        if (!(await db.getSetting('CLAUDE_MCP_CHAT_MODEL'))) {
            await db.setSetting('CLAUDE_MCP_CHAT_MODEL', process.env.CLAUDE_MCP_CHAT_MODEL || 'claude-sonnet-4-5');
        }
        if (process.env.MCP_CLIENT_ID && process.env.MCP_CLIENT_SECRET) {
            const existingMcpId = await db.getSetting('MCP_CLIENT_ID');
            if (!existingMcpId) {
                await db.setSetting('MCP_CLIENT_ID', process.env.MCP_CLIENT_ID);
                await db.setSetting('MCP_CLIENT_SECRET', process.env.MCP_CLIENT_SECRET);
                if (process.env.MCP_SERVER_ENDPOINT) {
                    await db.setSetting('MCP_SERVER_ENDPOINT', process.env.MCP_SERVER_ENDPOINT);
                }
                console.log('DEBUG: Auto-configured MCP Credentials from environment.');
            }
        }

        // Migrate existing MCP settings to mcp_servers table
        console.log("DEBUG: Checking mcpCount...");
        const mcpCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM mcp_servers", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        console.log("DEBUG: mcpCount fetched:", mcpCount);

        if (mcpCount === 0) {
            const endpointUrl = await db.getSetting('MCP_SERVER_ENDPOINT');
            if (endpointUrl) {
                console.log('DEBUG: Migrating existing MCP settings to mcp_servers table...');
                const tokenUrl = await db.getSetting('MCP_TOKEN_URL');
                const clientId = await db.getSetting('MCP_CLIENT_ID');
                const clientSecret = await db.getSetting('MCP_CLIENT_SECRET'); // decrypted automatically
                
                let encryptedSecret = null;
                if (clientSecret) {
                    encryptedSecret = encrypt(clientSecret);
                }

                db.run(`INSERT INTO mcp_servers (name, endpoint_url, token_url, client_id, client_secret) VALUES (?, ?, ?, ?, ?)`,
                    ['AppRunner MCP (Migrated)', endpointUrl, tokenUrl, clientId, encryptedSecret],
                    (err) => {
                        if (err) console.error('Failed to migrate MCP settings', err);
                        else console.log('DEBUG: MCP settings migrated successfully.');
                    }
                );
            }
        }

        // Auto-register Knowledge Base MCP Server
        console.log("DEBUG: Checking kbMcpCount...");
        const kbMcpCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM mcp_servers WHERE name = 'Knowledge Base MCP (Built-in)'", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        console.log("DEBUG: kbMcpCount fetched:", kbMcpCount);

        if (kbMcpCount === 0) {
            console.log('DEBUG: Registering Knowledge Base MCP Server with ZTA credentials...');
            
            const domain = process.env.DOMAIN_NAME || 'localhost:8080';
            const isLocalhost = domain.includes('localhost') || domain.includes('127.0.0.1');
            const protocol = isLocalhost ? 'http' : 'https';
            
            const endpointUrl = `${protocol}://${domain}/api/mcp/knowledge/sse`;
            const tokenUrl = `${protocol}://${domain}/api/auth/token-exchange`;

            const clientId = 'macos-ui-internal-client';
            const rawSecret = process.env.DB_ENCRYPTION_KEY || 'development-encryption-key-123456';
            
            // Import encrypt function dynamically to prevent circular dependencies
            const { encrypt } = require('./crypto.cjs');
            const encryptedSecret = encrypt(rawSecret);

            db.run(`INSERT INTO mcp_servers (name, endpoint_url, token_url, client_id, client_secret) VALUES (?, ?, ?, ?, ?)`,
                ['Knowledge Base MCP (Built-in)', endpointUrl, tokenUrl, clientId, encryptedSecret],
                (err) => {
                    if (err) console.error('Failed to register Knowledge Base MCP Server', err);
                    else console.log('DEBUG: Knowledge Base MCP Server registered successfully with ZTA A2A Auth.');
                }
            );
        }

        // Auto-register Gemma 4 Local AI MCP Server
        console.log("DEBUG: Checking gemmaMcpCount...");
        const gemmaMcpCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM mcp_servers WHERE name = 'Gemma 4 Local MCP (Built-in)'", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        console.log("DEBUG: gemmaMcpCount fetched:", gemmaMcpCount);

        if (gemmaMcpCount === 0) {
            console.log('DEBUG: Registering Gemma 4 Local MCP Server with ZTA credentials...');
            
            const domain = process.env.DOMAIN_NAME || 'localhost:8080';
            const isLocalhost = domain.includes('localhost') || domain.includes('127.0.0.1');
            const protocol = isLocalhost ? 'http' : 'https';
            
            const endpointUrl = `${protocol}://${domain}/api/mcp/gemma/sse`;
            const tokenUrl = `${protocol}://${domain}/api/auth/token-exchange`;

            const clientId = 'macos-ui-internal-client';
            const rawSecret = process.env.DB_ENCRYPTION_KEY || 'development-encryption-key-123456';
            
            const { encrypt } = require('./crypto.cjs');
            const encryptedSecret = encrypt(rawSecret);

            db.run(`INSERT INTO mcp_servers (name, endpoint_url, token_url, client_id, client_secret) VALUES (?, ?, ?, ?, ?)`,
                ['Gemma 4 Local MCP (Built-in)', endpointUrl, tokenUrl, clientId, encryptedSecret],
                (err) => {
                    if (err) console.error('Failed to register Gemma 4 Local MCP Server', err);
                    else console.log('DEBUG: Gemma 4 Local MCP Server registered successfully with ZTA A2A Auth.');
                }
            );
        }

        // Auto-register ZTA MCP Gateway Servers (Meta-Catalog, Digital Agency, NPB)
        const ztaGatewayHost = process.env.ZTA_GATEWAY_HOST || 'http://host.docker.internal:8085';
        const { encrypt } = require('./crypto.cjs');
        const analystSecretEncrypted = encrypt('analyst-secret-2026');

        const ztaServers = [
            {
                name: 'デジタル庁 行政手続分析 MCP (ZTA保護)',
                endpoint_url: `${ztaGatewayHost}/mcp/admin-procedures/sse`,
                token_url: `${ztaGatewayHost}/oauth/token`,
                client_id: 'macosui-analyst',
                client_secret: analystSecretEncrypted
            },
            {
                name: 'Meta-Catalog MCP (企業システム＆GenUIメタ情報)',
                endpoint_url: `${ztaGatewayHost}/mcp/catalog/sse`,
                token_url: `${ztaGatewayHost}/oauth/token`,
                client_id: 'macosui-analyst',
                client_secret: analystSecretEncrypted
            },
            {
                name: 'NPB Baseball (参照専用)',
                endpoint_url: `${ztaGatewayHost}/mcp/mariadb/sse`,
                token_url: `${ztaGatewayHost}/oauth/token`,
                client_id: 'macosui-analyst',
                client_secret: analystSecretEncrypted
            }
        ];

        for (const s of ztaServers) {
            const count = await new Promise((resolve) => {
                db.get("SELECT COUNT(*) as count FROM mcp_servers WHERE name = ?", [s.name], (err, row) => {
                    if (err) resolve(-1);
                    else resolve(row ? row.count : 0);
                });
            });
            if (count === 0) {
                console.log(`DEBUG: Registering ${s.name}...`);
                db.run(
                    `INSERT INTO mcp_servers (name, endpoint_url, token_url, client_id, client_secret) VALUES (?, ?, ?, ?, ?)`,
                    [s.name, s.endpoint_url, s.token_url, s.client_id, s.client_secret],
                    (err) => {
                        if (err) console.error(`Failed to register ${s.name}`, err);
                        else console.log(`DEBUG: ${s.name} registered successfully.`);
                    }
                );
            }
        }

        // Migrate any existing mcp_servers with https://localhost to http://localhost
        db.run("UPDATE mcp_servers SET endpoint_url = REPLACE(endpoint_url, 'https://localhost', 'http://localhost'), token_url = REPLACE(token_url, 'https://localhost', 'http://localhost') WHERE endpoint_url LIKE 'https://localhost%'");

        // Auto-register / Merge Default MCP Quick Prompts
        console.log("DEBUG: Checking existingPrompts...");
        const rawPrompts = await db.getSetting('MCP_QUICK_PROMPTS');
        let currentPrompts = [];
        try {
            if (rawPrompts) currentPrompts = JSON.parse(rawPrompts);
        } catch (e) {
            currentPrompts = [];
        }

        const requiredPrompts = [
            { label: "利用可能なツール", prompt: "利用可能なツール一覧を表示してください。" },
            { label: "Authorごとの月別投稿数", prompt: "ナレッジベースのAuthorごとの月別投稿数を教えてください" },
            { label: "記事トークン数", prompt: "ナレッジベースの記事ごとのトークン数を教えてください" },
            { label: "トークン数のクロス集計", prompt: "月別と著者別のインプットトークンとアウトプットトークンをクロス集計して表にして" },
            { label: "AppRunnerメトリクス", prompt: "AppRunnerの最新メトリクスを教えてください" },
            { label: "Docker一覧", prompt: "Dockerのコンテナ一覧を取得して表にまとめてください" },
            {
                label: "行政手続・ライフイベント別デジタル化ダッシュボード",
                prompt: "デジタル庁の行政手続等の棚卸調査データ（procedures-survey-r7）を分析し、国民の生活に直結する【行政手続 ライフイベント別デジタル化＆行政改革ダッシュボード】を作成してください。\n\nまずは Meta-Catalog（get_catalog_detail または list_catalog）で推奨設計図を確認し、summarize_records ツールを用いて以下のデータを集計してください：\n1. 国民ライフイベント（「死亡・相続」「引越し」「医療・健康」「税金」「出生・こども」など）別の手続種類数の集計（explode: \"手続が行われるイベント(個人)\"）\n2. 提出が義務付けられている添付書類（「住民票」「戸籍」「登記事項証明書」「印鑑登録証明書」など）の提出要求件数の集計（explode: \"申請時に添付させる書類\"）\n\n集計結果に基づき、以下のGenUI設計要件を満たす洗練されたインタラクティブダッシュボード（TailwindCSS + Chart.js）を出力してください：\n1. 【最上部サマリーカード（3列）】：\n   - ①「調査対象手続総数」: 76,275件（全国法令手続全数調査）\n   - ②「重点ライフイベント」: 14分野（死亡・相続、引越し、出生など）\n   - ③「最大ボトルネック」: 紙原本の提出義務（戸籍・住民票・印鑑証明等の撤廃進捗）\n2. 【ライフイベント別 手続数ランキング横棒グラフ（Chart.js）】：\n   - 各ライフイベントの手続件数を可視化し、国民の負担が大きい領域を一目で把握可能にする\n3. 【申請時に求められる添付書類の構成比（ドーナツチャート）】：\n   - 住民票・戸籍・印鑑証明・登記事項証明書などの割合を色分け表示\n4. 【行政改革・重点ターゲット一覧テーブル】：\n   - イベント名、手続件数、代表的な添付書類、改革優先度（「最優先」「重要」「要検討」）のバッジ表示\n5. 【AIアナリスト改革提言バナー】：\n   - 「書かない窓口」やマイナンバー連携・ベースレジストリ連携による添付書類撤廃のボトルネックと提言"
            },
            {
                label: "紙原本（戸籍・住民票）添付義務の手続き分析",
                prompt: "デジタル庁の行政手続棚卸調査（procedures-survey-r7）から、国民や企業が申請する際に「住民票」「戸籍」「印鑑登録証明書」などの紙原本の添付をいまだに義務付けている手続きを分析してください。\n\nsummarize_records や query_records を用いて、添付書類の撤廃状況（添付書類等提出の撤廃/省略状況）や所管府省庁別の傾向を集計し、わかりやすいGenUIレポートとして可視化してください。"
            },
            {
                label: "2025年阪神タイガース優勝の立役者",
                prompt: "MariaDBの「打者成績（batting_stats）」および「投手成績（pitching_stats）」から、2024年と2025年の2カ年データを比較し、セ・パ両リーグの他球団ライバルを含めた【2024 vs 2025 NPB 投打総合・戦力進化ダッシュボード】を作成してください。\n\n情報量が多くてもUIがビジー（過密）にならず、直感的に戦力UPがわかる以下のGenUI設計要件を満たしてください：\n\n1. 【最上部：2024 ➔ 2025 戦力UP・最大跳躍サマリー（3分割カード）】：\n   - ①「最大跳躍スラッガー」：前年から最もWAR・本塁打を伸ばした野手（例: 佐藤輝明 +3.4 WAR、森下翔太など）\n   - ②「最大跳躍エース」：前年から防御率・投球回・WARを劇的に改善した先発投手（例: 才木浩人など）\n   - ③「鉄壁リリーフ進化」：セーブ・ホールド数を大幅に上積みした守護神・セットアッパー（岩崎優、桐敷拓馬、R.マルティネスなど）\n\n2. 【タブ切り替え（Tabs）によるスッキリした画面構成】：\n   画面が混雑しないよう、以下の3つのタブで整理して表示してください：\n   - [⚾ 野手編 (2カ年比較)]\n   - [🎯 先発投手編 (2カ年比較)]\n   - [🛡️ 救援投手編 (クローザー＆中継ぎ)]\n\n3. 【各タブ内の構成（グラフ ＋ 前年比バッジ ＋ クリック連動カード）】：\n   - 【Chart.js 2カ年グループ棒グラフ】：\n     2024年（グレー） vs 2025年（鮮やかなブルー）を選手ごとに2本並べて表示し、一目で伸び代がわかるようにする\n   - 【前年比増減バッジ】：\n     数字の横に「+3.4 ▲（緑色）」や「-0.3 ▼（赤色）」のコンパクトなピルバッジを配置し、戦力増減を瞬時に判別可能にする\n   - 【クリック連動・選手詳細カード】：\n     グラフのバーや一覧の行をクリックすると、下部または右側のカードにその選手の2カ年全スタッツ（打率・本塁打・打点・OPS・タイトル / 防御率・WHIP・K数・S・H）が切り替わって深掘り表示される仕組み\n\n4. 【投手支配力マトリックスと見方ガイド（投手タブ内）】：\n   - WHIP（横軸） vs 防御率（縦軸）の散布図\n   - ★必須：グラフ直下に「※左下（WHIP 1.00未満・防御率1点台）が絶対的守護神・エースの領域」という解説注記を配置\n\n5. 【AIアナリスト戦力分析講評】：\n   - 2024年から2025年にかけて、他球団（ソフトバンク・巨人・中日など）と阪神タイガースのどちらがより戦力を底上げできたかの総合考察"
            },
            {
                label: "2026年日本シリーズ（ソフトバンクvsDeNA）戦力徹底比較",
                prompt: "MariaDBの「打者成績（batting_stats）」、「投手成績（pitching_stats）」、「対戦データ（games）」、「順位表（team_standings）」から、2026年の日本シリーズで激突する【福岡ソフトバンクホークス vs 横浜DeNAベイスターズ】の戦力を徹底比較・分析したGenUIダッシュボードを作成してください。\n\n阪神タイガースをCSファイナルステージで破って下克上進出を果たした横浜DeNAベイスターズと、圧倒的勝率でパ・リーグを制覇した福岡ソフトバンクホークスの直接対決について、以下の観点を網羅してください：\n1. 【最上部サマリーカード（キーマッチアップ）】：\n   - ①「打撃力対決」：近藤健介・栗原陵矢・山川穂高 vs 牧秀悟・オースティン・佐野恵太・宮﨑敏郎（チーム打率・本塁打・OPS比較）\n   - ②「エース先発対決」：有原航平・モイネロ vs 東克樹・ジャクソン・ケイ（防御率・WHIP・投球回比較）\n   - ③「救援・守護神対決」：杉山一樹・ヘルナンデス vs 森原康平・伊勢大夢（セーブ数・防御率・リリーフ安定度）\n2. 【直接対戦＆過去の日本シリーズ因縁分析】：\n   - 2024年日本シリーズ（DeNAが4勝2敗で日本一）および2026年交流戦（ソフトバンク2勝1敗）の対戦履歴（gamesテーブル）からの傾向分析\n   - DeNAのCSファイナル（阪神戦）での勝ち上がり要因（東・ケイの好投、森原の連続セーブ、牧・オースティンの決定力）\n3. 【投打スタッツ比較グラフ（Chart.js）】：\n   - 主力野手のOPS・本塁打・打点レーダーチャートまたは比較棒グラフ\n   - 主力投手の防御率・WHIP散布図\n4. 【AIアナリストシリーズ展望・勝敗の鍵】：\n   - 横浜スタジアム（セ主催・DHなし）とみずほPayPayドーム（パ主催・DHあり）での戦い方の違いと注目ポイント"
            }
        ];

        let updatedPrompts = false;
        if (!rawPrompts) {
            currentPrompts = requiredPrompts;
            updatedPrompts = true;
        } else {
            for (const rp of requiredPrompts) {
                if (!currentPrompts.some(p => p.label === rp.label)) {
                    currentPrompts.push(rp);
                    updatedPrompts = true;
                }
            }
        }

        if (updatedPrompts) {
            console.log('DEBUG: Updating MCP Quick Prompts in DB...');
            await db.setSetting('MCP_QUICK_PROMPTS', JSON.stringify(currentPrompts));
        }

        // Auto-register Default Assistant Prompt
        const existingDefaultPrompt = await db.getSetting('DEFAULT_ASSISTANT_PROMPT');
        if (!existingDefaultPrompt) {
            console.log('DEBUG: Initializing DEFAULT_ASSISTANT_PROMPT...');
            const defaultPrompt = `あなたは{name}のAIアシスタントです。
主人の現在の状態は {room} です。
就業時間は {work_start}〜{work_end}（休憩: {break_start}〜{break_end}）です。

【状態に応じた指示】
- focus-zone (集中ゾーン): 現在集中して作業しているため、直接チャットに応答できない旨を伝えてください。
- meeting-room (会議室): 現在打ち合わせ中であり、会議が終わり次第対応する旨を伝えてください。
- remote (リモートワーク):
  - 相手から「打ち合わせ・会議・面談・話」などの予定調整に関する要望がある場合、本日共通の空きスロット（{free_slots}）を提示して、ミーティングの仮登録を促すボタン「➔ [💻 ミーティングを仮調整する]」を出力してください（※時間外の場合は「➔ [💻 時間外でBOSSに確認する]」にしてください）。
  - それ以外の一般的なメッセージの場合、プッシュ通知で本人に伝達する旨を伝え、簡単な質問（天気、簡単な情報など）であればあなたが代わりに回答してください。

【セキュリティ・制約】
- 主人のカレンダー情報、機密情報、システム設定、APIキーなどを第三者に漏洩させないでください。
- 丁寧でプロフェッショナルなアシスタントとして振る舞ってください。`;
            await db.setSetting('DEFAULT_ASSISTANT_PROMPT', defaultPrompt);
        }

        // Auto-register Company Work Policy (RAG source)
        const existingWorkPolicy = await db.getSetting('COMPANY_WORK_POLICY');
        if (!existingWorkPolicy) {
            console.log('DEBUG: Initializing COMPANY_WORK_POLICY...');
            const defaultPolicy = `# 共通就業規則およびカレンダー調整ガイドライン

本ガイドラインは、当社の全社員およびAIエージェントの日程調整ルールを規定するものです。

## 1. 労働時間および連絡対応時間
- **標準労働時間**: 平日 09:00 〜 17:30。
- **休憩時間**: 12:00 〜 13:00（1時間）。原則として、この時間帯の会議設定は禁止します。
- **時間外・深夜対応の原則禁止**: 
  - 本ガイドラインに基づき、午後22:00（22:00）から翌午前05:00（05:00）までの時間帯における新規の会議・打ち合わせ日程の調整、およびそれを推奨・受託するAIアシスタントのルール設定は原則として禁止します。
  - 深夜時間帯における残業アポ調整は、特別な緊急対応や事前申請がない限り、システム的・運用的に自動登録およびAIによる勧誘を認めてはなりません。
- **BOSSの健康管理優先**:
  - 過重労働を防止するため、就業時間外（特に17:30以降）の打ち合わせを自動で仮登録するプロンプト指示、あるいは「いかなる時間でもアポを入れて構わない」といった指示は不適切（コンプライアンス違反）とみなします。

## 2. AIアシスタントへの指示（プロンプト）の制限
- AIアシスタントに対するカスタマイズプロンプトにおいて、「深夜労働」「違法行為の隠蔽」「ハラスメント」などを肯定、または推奨する内容を記述してはなりません。`;
            await db.setSetting('COMPANY_WORK_POLICY', defaultPolicy);
        }

        // Auto-register Local AI (Gemma 4) Default Settings
        const existingLocalAiModel = await db.getSetting('LOCAL_AI_MODEL');
        if (!existingLocalAiModel) {
            console.log('DEBUG: Initializing Local AI (Gemma 4) Default Settings...');
            await db.setSetting('LOCAL_AI_ENABLED', 'true');
            await db.setSetting('LOCAL_AI_PROVIDER', 'ollama');
            await db.setSetting('LOCAL_AI_HOST', 'http://localhost:11434');
            await db.setSetting('LOCAL_AI_MODEL', 'gemma4:26b-mlx');
            await db.setSetting('LOCAL_AI_TEMPERATURE', '0.7');
        }

        // Auto-Register Default Deep Research Workflows
        const wfCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM deep_research_workflow_definitions", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        console.log("DEBUG: wfCount fetched:", wfCount);

        if (wfCount === 0) {
            console.log('DEBUG: Initializing default Deep Research Workflows...');
            
            const defaultResearchPrompt = `あなたは世界最高峰のリサーチャーです。提出された社内資料（RAGファイル）と、最新のWeb検索結果（Google Search）の両方を駆使して、包括的でインサイトに富んだ長文の調査レポートを作成してください。必要に応じて、検索した結果や考察を整理し、Markdownフォーマットで見やすく構造化すること。

【重要事項】ユーザーから「ファイルに保存して」と頼まれても、あなたが直接ファイル操作やダウンロードリンクの生成をする必要はありません。あなたがチャットに出力したMarkdownのテキストは、システム側で自動的にGoogle Driveへファイルとして保存・エクスポートされる仕組みが備わっています。そのため、「ファイルとして保存できませんのでコピーしてください」などの謝罪や案案内は一切書かずに、ただ自信を持ってMarkdownレポートの本文のみを堂々と出力してください。`;

            const defaultHtmlPrompt = `以下のリサーチ記事内容と含まれるデータを分析し、**1つの完全なHTMLファイル**を作成してください。
Tailwind CSSのCDNを利用してモダンなデザインにし、純粋なHTML文字列のみを返してください。

=== テーマ: {{title}} ===

{{report}}`;

            const defaultNanoPrompt = `以下のレポート内容を完璧に表現した、プロフェッショナルなインフォグラフィックを1枚生成してください。

=== レポート内容 ===

{{report}}`;

            const researchModel = await db.getSetting('GEMINI_RESEARCH_MODEL') || 'deep-research-pro-preview-12-2025';
            const researchPrompt = (await db.getSetting('DEEP_RESEARCH_PROMPT')) || defaultResearchPrompt;
            const nanoModel = await db.getSetting('GEMINI_NANO_BANANA_MODEL') || 'gemini-3.1-pro-preview';
            const nanoPrompt = (await db.getSetting('NANO_BANANA_PROMPT')) || defaultNanoPrompt;
            const htmlModel = await db.getSetting('GEMINI_HTML_SVG_MODEL') || 'gemini-3.1-flash-lite-preview';
            const htmlPrompt = (await db.getSetting('HTML_SVG_PROMPT')) || defaultHtmlPrompt;
            const folderId = await db.getSetting('geminiResearchFolderId') || '';

            // Also persist them to settings if not set
            if (!await db.getSetting('DEEP_RESEARCH_PROMPT')) await db.setSetting('DEEP_RESEARCH_PROMPT', defaultResearchPrompt);
            if (!await db.getSetting('HTML_SVG_PROMPT')) await db.setSetting('HTML_SVG_PROMPT', defaultHtmlPrompt);
            if (!await db.getSetting('NANO_BANANA_PROMPT')) await db.setSetting('NANO_BANANA_PROMPT', defaultNanoPrompt);

            const crypto = require('crypto');
            
            // 1. HTML/SVG Knowledge Generation
            const htmlId = crypto.randomUUID();
            db.run(`INSERT INTO deep_research_workflow_definitions (id, name, description, research_model, research_prompt, output_type, output_model, output_prompt, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    htmlId,
                    'HTML/SVGナレッジ生成',
                    'Deep Researchを実行し、結果をインタラクティブなHTML/SVG形式のドキュメントとして出力・公開し、Google Driveへ保存します。',
                    researchModel,
                    researchPrompt,
                    'html',
                    htmlModel,
                    htmlPrompt,
                    folderId
                ]
            );

            // 2. Infographic Generation
            const infoId = crypto.randomUUID();
            db.run(`INSERT INTO deep_research_workflow_definitions (id, name, description, research_model, research_prompt, output_type, output_model, output_prompt, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    infoId,
                    'インフォグラフィック画像生成',
                    'Deep Researchを実行し、結果のポイントを整理したプロフェッショナルな画像アセット（インフォグラフィック）を出力し、Google Driveへ保存します。',
                    researchModel,
                    researchPrompt,
                    'infographic',
                    nanoModel,
                    nanoPrompt,
                    folderId
                ]
            );
            
            console.log('DEBUG: Default Deep Research Workflows initialized with complete prompts.');
        }

        // Auto-register / Migrate Claude Unified Deep Research Workflow (for both new and existing DBs)
        const claudeWfCount = await new Promise((resolve) => {
            db.get(
                "SELECT COUNT(*) as count FROM deep_research_workflow_definitions WHERE name LIKE '%Claude%' OR research_model LIKE 'claude-%'",
                [],
                (err, row) => {
                    if (err) resolve(-1);
                    else resolve(row ? row.count : 0);
                }
            );
        });

        if (claudeWfCount === 0) {
            console.log('DEBUG: Initializing Claude Unified Deep Research Workflow...');
            const claudeDefaultModel = await db.getSetting('CLAUDE_RESEARCH_MODEL') || await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
            const folderId = await db.getSetting('geminiResearchFolderId') || '';

            const claudeResearchPrompt = `あなたは世界最高峰の戦略リサーチャー・アナリスト（Anthropic Claude Deep Research Agent）です。
提出された過去ナレッジ（RAG資料）およびビルトインWeb検索ツール（web_search）を最大10回まで多角的に駆使して、一次情報・公式統計・最新の業界動向・反証データを徹底的に調査し、包括的でインサイトに富んだ長文の調査レポートを日本語のMarkdown形式で作成してください。

【Claude リサーチ・ハーネス規約】
1. 検索戦略の多角化: 単一の検索クエリに依存せず、日本語・英語のキーワードや異なる切り口（市場規模、技術動向、規制・政策、競合比較、課題・リスク）で複数回Web検索を実行し、ファクトの裏付けを取ること。
2. 構造化レポート形式:
   - 冒頭に必ず \`# 調査レポートのタイトル\` を記載する。
   - 「エグゼクティブサマリー（重要結論3〜5点）」「背景・現状分析」「定量データ・比較分析（必ずMarkdownテーブルを含める）」「ケーススタディ・具体例」「今後の展望・戦略的提言」「参照情報源（URLリンク付き）」の章立てで論理的に構成する。
3. 定量性・客観性の徹底: 抽象的な表現を避け、可能な限り具体的な数値・年代・出典元を明記すること。
4. 【重要事項】あなたが生成したMarkdownレポートは、MacOSUIの自動パイプライン（ハーネス）によって自動的にHTML/SVGビジュアライゼーションへ変換され、Google Driveおよびナレッジベースへ自動保存されます。「ファイルを直接保存できません」等のメタ発言や謝罪は一切出力せず、純粋なMarkdownレポート本文のみを堂々と出力してください。`;

            const claudeHtmlPrompt = `あなたは卓越したデータビジュアライゼーション＆フロントエンドアーキテクト（Anthropic Claude Artifact / GenUI エンジン）です。
以下のDeep Research調査レポートの内容と定量データを余すことなく分析し、経営層や意思決定者が一目でインサイトを把握できる**1つの完全で自己完結したインタラクティブHTML/SVGダッシュボードファイル**を作成してください。

【Claude HTML/SVG 生成ハーネス規約】
1. 技術スタック:
   - Tailwind CSS (CDN: \`https://cdn.tailwindcss.com\`) を利用し、洗練されたモダンなUI（グラスモーフィズム、美しいカードレイアウト、適切な余白とタイポグラフィ）を構築すること。
   - 定量データや比較表は、インラインSVGチャート（棒グラフ、折れ線グラフ、ドーナツチャート、レーダーチャート、アーキテクチャ図解、フローチャート等）または Chart.js (CDN) を用いて視覚的に描画すること。
2. 画面構成要件:
   - 最上部: テーマタイトル、調査サマリーバッジ、主要KPI・重要ファクトを示す3〜4枚のハイライトサマリーカード。
   - 中盤: タブ切り替えまたはセクション分けによる詳細分析、インラインSVGによる視覚的図解・データグラフ、構造化された比較テーブル。
   - 下部: 戦略的提言（アクションプラン）カードおよび参照ソース一覧。
3. 出力フォーマット厳守:
   - \`<!DOCTYPE html>\` から \`</html>\` までを含む純粋なHTMLコードのみを出力すること（前後の挨拶や解説文は一切不要）。
   - 文字化けやレイアウト崩れを防ぎ、レスポンシブかつ印刷・大画面投影にも耐えうる高品質なデザインにすること。

=== テーマ: {{title}} ===

{{report}}`;

            const crypto = require('crypto');
            const claudeWfId = crypto.randomUUID();
            db.run(
                `INSERT INTO deep_research_workflow_definitions (id, name, description, research_model, research_prompt, output_type, output_model, output_prompt, folder_id, reference_knowledge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    claudeWfId,
                    'Claude 統合リサーチ＆HTML/SVG生成',
                    'Anthropic Claudeの単一モデルでWeb検索調査（Task 1）からインタラクティブHTML/SVGダッシュボード生成（Task 2）までを一貫実行し、Google Driveへ自動保存します。',
                    claudeDefaultModel,
                    claudeResearchPrompt,
                    'html',
                    claudeDefaultModel,
                    claudeHtmlPrompt,
                    folderId,
                    1
                ],
                (err) => {
                    if (err) console.error('Failed to initialize Claude Deep Research workflow:', err);
                    else console.log('DEBUG: Claude Unified Deep Research Workflow registered successfully.');
                }
            );
        }

        // Auto-register Default Analytics Pods (Digital Agency & NPB)
        const defaultPods = [
            {
                id: 'pod-digital-agency',
                name: 'デジ庁データ分析',
                description: 'デジタル庁 行政手続等の棚卸調査データ（7.6万件）に基づく行政改革ダッシュボード・分析レポート'
            },
            {
                id: 'pod-npb-analytics',
                name: 'NPB野球データ分析',
                description: 'プロ野球 2024-2025 マルチ年度 セイバーメトリクス分析ダッシュボード'
            }
        ];

        for (const pod of defaultPods) {
            const exists = await new Promise((resolve) => {
                db.get("SELECT COUNT(*) as count FROM pods WHERE id = ? OR name = ?", [pod.id, pod.name], (err, row) => {
                    if (err) resolve(-1);
                    else resolve(row ? row.count : 0);
                });
            });
            if (exists === 0) {
                console.log(`DEBUG: Initializing Pod: ${pod.name}...`);
                db.run(
                    "INSERT INTO pods (id, name, description) VALUES (?, ?, ?)",
                    [pod.id, pod.name, pod.description],
                    (err) => {
                        if (err) console.error(`Failed to register pod ${pod.name}`, err);
                        else console.log(`DEBUG: Pod ${pod.name} registered successfully.`);
                    }
                );
            }
        }

        // Auto-seed Sample AI Analytics Article into "デジ庁データ分析" Pod
        const sampleArticleCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM knowledge_articles WHERE title LIKE '%行政手続%'", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        if (sampleArticleCount === 0) {
            const fs = require('fs');
            const path = require('path');
            const sampleWidgetPath = path.join(__dirname, 'sample_widgets', 'digital_agency_dashboard.html');
            if (fs.existsSync(sampleWidgetPath)) {
                const sampleContent = fs.readFileSync(sampleWidgetPath, 'utf8');
                console.log('DEBUG: Seeding sample AI Analytics article into knowledge base...');
                db.run(
                    `INSERT INTO knowledge_articles (title, content, tags, author_id, pod_id) VALUES (?, ?, ?, ?, ?)`,
                    [
                        '行政手続 ライフイベント別デジタル化＆行政改革ダッシュボード',
                        sampleContent,
                        'AI Analytics,GenUI,デジタル庁,行政改革,ダッシュボード',
                        1,
                        'pod-digital-agency'
                    ],
                    (err) => {
                        if (err) console.error('Failed to seed sample knowledge article', err);
                        else console.log('DEBUG: Sample AI Analytics knowledge article seeded successfully.');
                    }
                );
            }
        }

        // Auto-seed NPB Sample Article into "NPB野球データ分析" Pod
        const npbArticleCount = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM knowledge_articles WHERE title LIKE '%NPB%'", [], (err, row) => {
                if (err) resolve(-1);
                else resolve(row ? row.count : 0);
            });
        });
        if (npbArticleCount === 0) {
            const fs = require('fs');
            const path = require('path');
            const npbWidgetPath = path.join(__dirname, 'sample_widgets', 'npb_dashboard.html');
            if (fs.existsSync(npbWidgetPath)) {
                const npbContent = fs.readFileSync(npbWidgetPath, 'utf8');
                console.log('DEBUG: Seeding NPB AI Analytics article into knowledge base...');
                db.run(
                    `INSERT INTO knowledge_articles (title, content, tags, author_id, pod_id) VALUES (?, ?, ?, ?, ?)`,
                    [
                        'NPB 2024-2025 マルチ年度 セイバーメトリクス分析ダッシュボード',
                        npbContent,
                        'AI Analytics,GenUI,NPB,プロ野球,セイバーメトリクス,ダッシュボード',
                        1,
                        'pod-npb-analytics'
                    ],
                    (err) => {
                        if (err) console.error('Failed to seed NPB knowledge article', err);
                        else console.log('DEBUG: NPB AI Analytics knowledge article seeded successfully.');
                    }
                );
            }
        }

    } catch (error) {
        console.error('Error during auto-activation:', error);
    }
}

module.exports = db;
