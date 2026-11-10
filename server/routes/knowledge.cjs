const express = require('express');
const db = require('../db.cjs');
const { GoogleGenAI } = require('@google/genai');
const llmAdapter = require('../services/llmAdapter.cjs');

const router = express.Router();

async function calculateTokens(content) {
    if (!content) return 0;
    try {
        const apiKey = await db.getSetting('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
        const claudeApiKey = await db.getSetting('CLAUDE_API_KEY') || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
        const aiProvider = (await db.getSetting('AI_PROVIDER')) || (claudeApiKey && !apiKey ? 'claude' : 'gemini');

        if ((aiProvider === 'claude' || !apiKey) && claudeApiKey) {
            const claudeModel = await db.getSetting('CLAUDE_MODEL') || 'claude-sonnet-4-6';
            return await llmAdapter.countClaudeTokens({ apiKey: claudeApiKey, model: claudeModel, content });
        }
        if (apiKey) {
            const ai = new GoogleGenAI({ apiKey: apiKey, httpOptions: { timeout: 300000 } });
            const modelName = await db.getSetting('GEMINI_MODEL') || 'gemini-2.5-pro';
            const response = await ai.models.countTokens({
                model: modelName,
                contents: content
            });
            return response.totalTokens || Math.ceil(content.length / 4);
        }
    } catch (e) {
        console.error("Token calculation failed, using fallback:", e.message);
    }
    return Math.ceil(content.length / 4);
}




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
        console.error("Error reading RBAC policies:", e);
        return [];
    }
}

// GET: 全ナレッジ記事の一覧取得（タグおよびPodによる絞り込み対応）
router.get('/', async (req, res) => {
    const { tag, pod_id } = req.query;
    
    // RBACによるPod制限の取得
    const allowedPods = await getAllowedPodsForUser(req.user);
    const hasAllAccess = allowedPods.includes('*');
    
    let query = `
        SELECT k.id, k.title, k.tags, k.author_id, k.pod_id, k.created_at, k.updated_at, u.name as author_name,
               CASE WHEN u.avatar_url LIKE 'data:%' THEN ('/api/users/' || u.id || '/avatar') ELSE u.avatar_url END as author_avatar
        FROM knowledge_articles k
        LEFT JOIN users u ON k.author_id = u.id
        WHERE 1=1
    `;
    let params = [];
    
    // RBACアクセス制限：権限のないPodの記事は除外（共通は常にOK）
    if (!hasAllAccess) {
        if (allowedPods.length > 0) {
            const placeholders = allowedPods.map(() => "?").join(",");
            query += ` AND (k.pod_id IN (${placeholders}) OR k.pod_id IS NULL OR k.pod_id = '')`;
            params.push(...allowedPods);
        } else {
            query += " AND (k.pod_id IS NULL OR k.pod_id = '')";
        }
    }
    
    if (tag) {
        query += " AND k.tags LIKE ?";
        params.push(`%${tag}%`);
    }
    
    if (pod_id !== undefined) {
        if (pod_id === 'null' || pod_id === '' || pod_id === 'public') {
            query += " AND (k.pod_id IS NULL OR k.pod_id = '')";
        } else {
            query += " AND k.pod_id = ?";
            params.push(pod_id);
        }
    }
    
    query += " ORDER BY k.updated_at DESC";

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        // TagsをJSONパースして配列に戻す
        const articles = rows.map(row => {
            try {
                row.tags = JSON.parse(row.tags || '[]');
            } catch(e) {
                row.tags = [];
            }
            return row;
        });
        
        res.json(articles);
    });
});

// POST: HTMLダッシュボードやレポートをEA内部サイト (/reports/:id.html) としてパブリッシュ
router.post('/publish', async (req, res) => {
    try {
        const { title, content, mimeType } = req.body;
        if (!content) {
            return res.status(400).json({ error: 'Content is required to publish' });
        }

        const crypto = require('crypto');
        const id = crypto.randomUUID();
        const safeMimeType = mimeType || 'text/html';
        const safeTitle = title || 'Untitled Report';

        await new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO published_reports (id, title, content, mime_type) VALUES (?, ?, ?, ?)",
                [id, safeTitle, content, safeMimeType],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        res.json({ success: true, id });
    } catch (error) {
        console.error("[Knowledge Publish Error]:", error);
        res.status(500).json({ error: error.message });
    }
});

// GET: 単一記事の詳細取得
router.get('/:id', async (req, res) => {
    const allowedPods = await getAllowedPodsForUser(req.user);
    const hasAllAccess = allowedPods.includes('*');

    db.get(`
        SELECT k.*, u.name as author_name,
               CASE WHEN u.avatar_url LIKE 'data:%' THEN ('/api/users/' || u.id || '/avatar') ELSE u.avatar_url END as author_avatar
        FROM knowledge_articles k
        LEFT JOIN users u ON k.author_id = u.id
        WHERE k.id = ?
    `, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Article not found' });
        
        // RBACアクセス制限：権限のないPodの記事は取得不可
        if (!hasAllAccess && row.pod_id && !allowedPods.includes(row.pod_id)) {
            return res.status(403).json({ error: 'このナレッジ記事へのアクセス権限がありません。' });
        }
        
        try {
            row.tags = JSON.parse(row.tags || '[]');
        } catch(e) {
            row.tags = [];
        }
        
        res.json(row);
    });
});

// POST: 新規記事の作成
router.post('/', async (req, res) => {
    const { title, content, tags, input_tokens, output_tokens, pod_id } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    
    // RBAC検証：指定されたPodへのアクセス権があるか
    if (pod_id) {
        const allowedPods = await getAllowedPodsForUser(req.user);
        if (!allowedPods.includes('*') && !allowedPods.includes(pod_id)) {
            return res.status(403).json({ error: '指定されたPodへのアクセス権限がありません。' });
        }
    }
    
    const tagsJson = JSON.stringify(tags || []);
    const authorId = req.user.id; // requireAuthによる検証結果を利用
    
    let finalInputTokens = input_tokens || 0;
    let finalOutputTokens = output_tokens;
    
    // Calculate token count asynchronously if not provided (e.g. manual creation)
    if (finalOutputTokens === undefined || finalOutputTokens === null) {
        finalOutputTokens = await calculateTokens(content);
    }
    const tokenCount = finalInputTokens + finalOutputTokens;
    
    db.run(
        "INSERT INTO knowledge_articles (title, content, tags, author_id, token_count, input_tokens, output_tokens, pod_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [title, content, tagsJson, authorId, tokenCount, finalInputTokens, finalOutputTokens, pod_id || null],
        function (err) {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.status(201).json({ id: this.lastID, message: 'Article created successfully' });
        }
    );
});

// PUT: 記事の更新
router.put('/:id', async (req, res) => {
    const { title, content, tags, input_tokens, output_tokens, pod_id } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    
    // RBAC検証：指定されたPodへのアクセス権があるか
    if (pod_id) {
        const allowedPods = await getAllowedPodsForUser(req.user);
        if (!allowedPods.includes('*') && !allowedPods.includes(pod_id)) {
            return res.status(403).json({ error: '指定されたPodへのアクセス権限がありません。' });
        }
    }
    
    const tagsJson = JSON.stringify(tags || []);
    
    let finalInputTokens = input_tokens || 0;
    let finalOutputTokens = output_tokens;
    
    // Calculate token count asynchronously if not provided
    if (finalOutputTokens === undefined || finalOutputTokens === null) {
        finalOutputTokens = await calculateTokens(content);
    }
    const tokenCount = finalInputTokens + finalOutputTokens;
    
    db.run(
        "UPDATE knowledge_articles SET title = ?, content = ?, tags = ?, token_count = ?, input_tokens = ?, output_tokens = ?, pod_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [title, content, tagsJson, tokenCount, finalInputTokens, finalOutputTokens, pod_id || null, req.params.id],
        function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (this.changes === 0) return res.status(404).json({ error: 'Article not found' });
            res.json({ success: true, message: 'Article updated successfully' });
        }
    );
});

// DELETE: 記事の削除
router.delete('/:id', (req, res) => {
    db.run("DELETE FROM knowledge_articles WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (this.changes === 0) return res.status(404).json({ error: 'Article not found' });
        res.json({ success: true, message: 'Article deleted successfully' });
    });
});

// GET /export: 全ナレッジベース記事の JSON エクスポート
router.get('/export/download', async (req, res) => {
    db.all("SELECT * FROM knowledge_articles ORDER BY id ASC", [], (err, rows) => {
        if (err) {
            console.error("Export error:", err);
            return res.status(500).json({ error: 'Database error during export' });
        }
        
        const exportData = {
            version: '2.2.2',
            exported_at: new Date().toISOString(),
            articles: rows.map(r => {
                try { r.tags = JSON.parse(r.tags || '[]'); } catch (e) { r.tags = []; }
                return r;
            })
        };

        const fileName = `knowledge_export_${new Date().toISOString().split('T')[0]}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exportData, null, 2));
    });
});

// POST /import: ナレッジベース記事の JSON インポート
router.post('/import/upload', async (req, res) => {
    const { articles } = req.body;
    if (!articles || !Array.isArray(articles)) {
        return res.status(400).json({ error: 'Invalid import package format. Array of articles is required.' });
    }

    const authorId = req.user ? req.user.id : 1;
    let importedCount = 0;
    let errorsCount = 0;

    const stmt = db.prepare("INSERT INTO knowledge_articles (title, content, tags, author_id, token_count, input_tokens, output_tokens, pod_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        articles.forEach(art => {
            if (!art.title) return;
            const tagsJson = JSON.stringify(Array.isArray(art.tags) ? art.tags : []);
            const tokenCount = art.token_count || 0;
            const inputTokens = art.input_tokens || 0;
            const outputTokens = art.output_tokens || 0;

            stmt.run(
                [art.title, art.content || '', tagsJson, authorId, tokenCount, inputTokens, outputTokens, art.pod_id || null],
                (err) => {
                    if (err) {
                        console.error("Import single row error:", err);
                        errorsCount++;
                    } else {
                        importedCount++;
                    }
                }
            );
        });

        stmt.finalize();

        db.run("COMMIT", (err) => {
            if (err) {
                console.error("Commit import error:", err);
                return res.status(500).json({ error: 'Failed to commit import transaction' });
            }
            res.json({
                success: true,
                message: `Knowledge base imported successfully (${importedCount} imported, ${errorsCount} errors).`,
                imported_count: importedCount,
                errors_count: errorsCount
            });
        });
    });
});

module.exports = { router };
