const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// メインデータベースとは物理的に隔離された監査ログ専用のデータベースファイル
const fs = require('fs');
const dataDir = path.resolve(__dirname, '../data');
const dbPath = fs.existsSync(dataDir)
    ? path.join(dataDir, 'audit_database.sqlite')
    : path.resolve(__dirname, 'audit_database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening audit database:', err.message);
    } else {
        console.log('Connected to the SQLite Audit database.');
        db.serialize(() => {
            db.run("PRAGMA wal_checkpoint(TRUNCATE);", () => {});
            db.run("PRAGMA journal_mode = DELETE;", () => {});
            db.run("PRAGMA synchronous = FULL;", () => {});
        });
        initDb();
    }
});

// 監査ログテーブルの初期化
function initDb() {
    db.run(`CREATE TABLE IF NOT EXISTS security_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_email TEXT,
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

/**
 * 堅牢なセキュリティ監査ログを非同期で記録するヘルパー関数
 * メインのAPI処理フローをブロックしないよう非同期プロミス形式で実装し、エラーも安全に処理します。
 * 
 * @param {Object} params
 * @param {number|null} params.userId - ユーザーID（未認証時は null/0）
 * @param {string|null} params.userEmail - ユーザーのメールアドレス
 * @param {string} params.eventType - イベント種別（例: login_success, session_hijacking_detected 等）
 * @param {string} params.action - 実行しようとしたアクション名（例: POST /api/gemini）
 * @param {string} params.status - 成否（success / failure / blocked）
 * @param {Object} [params.req] - ExpressのRequestオブジェクト（IPやUAを自動抽出するため）
 * @param {string} [params.ipAddress] - 直接指定する場合のIPアドレス
 * @param {string} [params.userAgent] - 直接指定する場合のUser-Agent
 * @param {Object|string|null} [params.details] - 追加の詳細情報（Objectの場合は自動でJSON文字列化）
 */
function logEvent({ userId, userEmail, eventType, action, status, req, ipAddress, userAgent, details }) {
    return new Promise((resolve) => {
        let finalIp = ipAddress || null;
        let finalUa = userAgent || null;

        if (req) {
            // リバースプロキシ環境（Nginx等）に対応したIPアドレス抽出
            finalIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.socket.remoteAddress;
            finalUa = req.headers['user-agent'] || null;
        }

        let finalDetails = details || null;
        if (details && typeof details === 'object') {
            try {
                finalDetails = JSON.stringify(details);
            } catch (e) {
                console.error('Failed to stringify security log details:', e);
                finalDetails = String(details);
            }
        }

        db.run(
            `INSERT INTO security_logs (user_id, user_email, event_type, action, status, ip_address, user_agent, details) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId || null, userEmail || null, eventType, action, status, finalIp, finalUa, finalDetails],
            function (err) {
                if (err) {
                    // 監査ログ自体の書き込みエラーはシステムをクラッシュさせないようにエラーログ出力のみにとどめる
                    console.error('CRITICAL: Failed to write to Security Audit database:', err.message);
                }
                resolve();
            }
        );
    });
}

/**
 * 管理者用のセキュリティログ一覧取得関数
 * @param {number} limit - 取得する最大件数（デフォルト500件）
 */
function getLogs(limit = 500) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM security_logs ORDER BY created_at DESC LIMIT ?`,
            [limit],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            }
        );
    });
}

module.exports = {
    logEvent,
    getLogs,
    db // 必要に応じて生の接続も公開
};
