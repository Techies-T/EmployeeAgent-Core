#!/usr/bin/env node
/**
 * install-widget.cjs
 * EA-Core 1.0.1 PQC Widget Plugin CLI Installer
 * 
 * Usage:
 *   node scripts/install-widget.cjs --source /path/to/ea-widget-virtual-office
 *   node scripts/install-widget.cjs --source /path/to/ea-widget-virtual-office.tar.gz
 *   node scripts/install-widget.cjs --url https://github.com/Techies-T/ea-widget-virtual-office/releases/download/v1.0.0/ea-widget-virtual-office-v1.0.0.tar.gz
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Auto-load development.env if available (server/development.env or data/development.env)
const envPaths = [
    path.resolve(__dirname, '../server/development.env'),
    path.resolve(__dirname, '../data/development.env'),
    '/app/data/development.env'
];
for (const envP of envPaths) {
    if (fs.existsSync(envP)) {
        require('dotenv').config({ path: envP });
        break;
    }
}

const { verifyPluginManifestSignature } = require('../server/services/pluginSignatureVerifier.cjs');

async function main() {
    const args = process.argv.slice(2);
    let sourcePath = '';
    let downloadUrl = '';
    let targetPluginDir = path.resolve(__dirname, '../server/plugins');

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--source' && args[i + 1]) {
            sourcePath = args[++i];
        } else if (args[i] === '--url' && args[i + 1]) {
            downloadUrl = args[++i];
        } else if (args[i] === '--target' && args[i + 1]) {
            targetPluginDir = path.resolve(args[++i]);
        }
    }

    if (!sourcePath && !downloadUrl) {
        console.error('❌ エラー: --source または --url を指定してください。');
        console.error('使用法: node scripts/install-widget.cjs --source <path> または --url <url>');
        process.exit(1);
    }

    const tempDir = path.resolve('/tmp', `ea-widget-install-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        let workDir = '';

        if (downloadUrl) {
            console.log(`🌐 パッケージをダウンロード中: ${downloadUrl}`);
            const archiveFile = path.join(tempDir, 'package.tar.gz');
            execSync(`curl -fsSL -o "${archiveFile}" "${downloadUrl}"`);
            console.log('📦 アーカイブを展開中...');
            const extractDir = path.join(tempDir, 'extracted');
            fs.mkdirSync(extractDir, { recursive: true });
            execSync(`tar -xzf "${archiveFile}" -C "${extractDir}"`);
            workDir = extractDir;
        } else if (sourcePath) {
            const stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) {
                console.log(`📁 ソースディレクトリを使用: ${sourcePath}`);
                workDir = sourcePath;
            } else if (sourcePath.endsWith('.tar.gz') || sourcePath.endsWith('.tgz')) {
                console.log(`📦 アーカイブを展開中: ${sourcePath}`);
                const extractDir = path.join(tempDir, 'extracted');
                fs.mkdirSync(extractDir, { recursive: true });
                execSync(`tar -xzf "${sourcePath}" -C "${extractDir}"`);
                workDir = extractDir;
            } else if (sourcePath.endsWith('.zip')) {
                console.log(`📦 Zipを展開中: ${sourcePath}`);
                const extractDir = path.join(tempDir, 'extracted');
                fs.mkdirSync(extractDir, { recursive: true });
                execSync(`unzip -q "${sourcePath}" -d "${extractDir}"`);
                workDir = extractDir;
            } else {
                throw new Error(`未対応のファイル形式です: ${sourcePath}`);
            }
        }

        // manifest.json / widget.manifest.json の探索 (直下またはサブディレクトリまたはdist内)
        function findManifest(dir) {
            const candidates = ['widget.manifest.json', 'manifest.json', 'dist/widget.manifest.json', 'dist/manifest.json'];
            for (const cand of candidates) {
                const p = path.join(dir, cand);
                if (fs.existsSync(p)) return p;
            }
            const subEntries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of subEntries) {
                if (ent.isDirectory() && ent.name !== 'node_modules') {
                    for (const cand of candidates) {
                        const p = path.join(dir, ent.name, cand);
                        if (fs.existsSync(p)) return p;
                    }
                }
            }
            return null;
        }

        let manifestPath = findManifest(workDir);
        if (!manifestPath) {
            throw new Error(`manifest.json / widget.manifest.json が見つかりません: ${workDir}`);
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const widgetId = manifest.id;
        const version = manifest.version;
        console.log(`🔍 ウィジェット検出: [${widgetId}] v${version} (${manifest.name})`);

        // dist ディレクトリの判定
        let bundleDir = path.join(workDir, 'dist');
        if (!fs.existsSync(bundleDir)) {
            if (fs.existsSync(path.join(path.dirname(manifestPath), 'index.html'))) {
                bundleDir = path.dirname(manifestPath);
            } else {
                bundleDir = workDir;
            }
        }

        // PQC ML-DSA-65 & Ed25519 デュアル署名 Gatekeeper 検証
        console.log('🛡️ Gatekeeper PQC ML-DSA-65 & Ed25519 署名検証を実行中...');
        const verification = await verifyPluginManifestSignature(manifest, { bundleDir });

        if (!verification.valid) {
            console.error(`🚨 【PQC署名検証不合格】${verification.error}`);
            console.error('詳細:', verification.details);
            process.exit(1);
        }

        console.log('✅ 【PQC署名検証合格】Dual-layer PQC ML-DSA-65 & Ed25519 署名および全ファイルハッシュが一致しました！');

        // 配備先ディレクトリの作成とコピー
        const finalDest = path.join(targetPluginDir, widgetId);
        if (fs.existsSync(finalDest)) {
            console.log(`⚠️ 既存のウィジェットを更新します: ${finalDest}`);
            fs.rmSync(finalDest, { recursive: true, force: true });
        }
        fs.mkdirSync(finalDest, { recursive: true });

        // ファイルをコピー
        execSync(`cp -R "${workDir}/"* "${finalDest}/"`);
        // 互換性のために manifest.json と widget.manifest.json の両方を直下および dist 内に同期
        const manifestStr = JSON.stringify(manifest, null, 2);
        fs.writeFileSync(path.join(finalDest, 'manifest.json'), manifestStr);
        fs.writeFileSync(path.join(finalDest, 'widget.manifest.json'), manifestStr);
        if (fs.existsSync(path.join(finalDest, 'dist'))) {
            fs.writeFileSync(path.join(finalDest, 'dist', 'manifest.json'), manifestStr);
            fs.writeFileSync(path.join(finalDest, 'dist', 'widget.manifest.json'), manifestStr);
        }

        // DB (INSTALLED_WIDGET_PLUGINS) にインストール状態を反映
        try {
            const pluginManager = require('../server/services/pluginManager.cjs');
            let generatedLicense = '';
            try {
                const licResult = pluginManager.generateWidgetLicenseKey(widgetId, { tenantId: 'default', daysValid: 3650 });
                if (licResult && licResult.licenseKey) {
                    generatedLicense = licResult.licenseKey;
                }
            } catch (_) {}

            await pluginManager.installWidgetPlugin(widgetId, {
                customManifest: manifest,
                mode: generatedLicense ? 'license' : 'trial',
                licenseKey: generatedLicense,
                source: downloadUrl ? 'github_release' : 'archive_package'
            });
            console.log(`📝 プラグインカタログおよびDBへの登録完了: [${widgetId}] (Status: active, Mode: licensed)`);
        } catch (dbErr) {
            console.warn(`⚠️ DBへの登録をスキップしました (直接実行時):`, dbErr.message);
        }

        console.log(`🎉 ウィジェット [${widgetId}] v${version} のインストールが完了しました！`);
        console.log(`📂 配備先: ${finalDest}`);
        console.log('🌐 リバースプロキシ エンドポイント: /plugin-proxy/' + widgetId + '/');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error('❌ インストール失敗:', err.message);
    process.exit(1);
});
