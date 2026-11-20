const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8099);
const CORE_CONTAINER_NAME = process.env.CORE_CONTAINER_NAME || 'macosui-local';
const VERIFY_COSIGN = String(process.env.VERIFY_COSIGN || 'true').toLowerCase() !== 'false';
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// Strict allowlist of managed container widgets
const WIDGET_RUNTIME_REGISTRY = {
    'mcp-chat': {
        containerName: 'ea-widget-mcp-chat',
        port: 8092,
        allowedImagePrefix: 'ghcr.io/techies-t/ea-widget-mcp-chat',
        defaultRepository: 'Techies-T/ea-widget-mcp-chat',
        healthPath: '/api/health'
    },
    'virtual-office': {
        containerName: 'ea-widget-virtual-office',
        port: 8091,
        allowedImagePrefix: 'ghcr.io/techies-t/ea-widget-virtual-office',
        defaultRepository: 'Techies-T/ea-widget-virtual-office',
        healthPath: '/api/health'
    }
};

const STRICT_IMAGE_REGEX = /^ghcr\.io\/techies-t\/ea-widget-[a-z0-9-]+(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/;

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                reject(new Error('Request payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(new Error('Invalid JSON payload'));
            }
        });
        req.on('error', reject);
    });
}

function verifyA2AToken(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
        throw new Error('Missing Bearer token');
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.aud !== 'service:plugin-updater' || decoded.type !== 'a2a_updater_token') {
        throw new Error('Invalid A2A updater token audience or type');
    }
    return decoded;
}

async function runDocker(args, timeoutMs = 120000) {
    const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function inspectCoreRuntime() {
    const { stdout } = await runDocker(['inspect', CORE_CONTAINER_NAME], 15000);
    const info = JSON.parse(stdout)[0];
    if (!info) {
        throw new Error(`Core container '${CORE_CONTAINER_NAME}' not found`);
    }

    const networks = Object.keys(info.NetworkSettings?.Networks || {});
    const networkName = networks[0] || 'bridge';

    let hostDataMount = null;
    for (const m of (info.Mounts || [])) {
        if (m.Destination === '/app/data') {
            hostDataMount = m.Source;
            break;
        }
    }

    // Forward essential shared runtime secrets from core container env if not set on updater
    const coreEnvMap = {};
    for (const entry of (info.Config?.Env || [])) {
        const eqIdx = entry.indexOf('=');
        if (eqIdx > 0) {
            coreEnvMap[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
        }
    }

    return { networkName, hostDataMount, coreEnvMap };
}

async function verifyCosignSignature(imageRef, repository) {
    if (!VERIFY_COSIGN) {
        console.warn(`[PluginUpdater] VERIFY_COSIGN=false: Skipping Cosign verification for ${imageRef}`);
        return { verified: false, skipped: true };
    }

    const identityRegexp = `^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/workflows/release-signed-plugin\\.yml@.*$`;
    try {
        await execFileAsync('cosign', [
            'verify',
            '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
            '--certificate-identity-regexp', identityRegexp,
            imageRef
        ], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
        return { verified: true, issuer: 'https://token.actions.githubusercontent.com', identityRegexp };
    } catch (err) {
        const msg = err.stderr || err.message || 'Cosign verification failed';
        throw new Error(`コンテナイメージの Cosign 証明書検証に失敗しました: ${msg.slice(0, 300)}`);
    }
}

async function waitForHealth(containerName, port, healthPath, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://${containerName}:${port}${healthPath}`;
    let lastError = 'No response';

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
            if (res.ok) {
                return true;
            }
            lastError = `HTTP ${res.status}`;
        } catch (err) {
            lastError = err.message;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`ヘルスチェック (${url}) がタイムアウトしました (${lastError})`);
}

async function containerExists(name) {
    try {
        await runDocker(['inspect', name], 10000);
        return true;
    } catch {
        return false;
    }
}

async function deployWidgetContainer({ widgetId, targetVersion, imageRef, repository }) {
    const spec = WIDGET_RUNTIME_REGISTRY[widgetId];
    if (!spec) {
        throw new Error(`Unsupported or unauthorized widgetId: ${widgetId}`);
    }

    const repo = repository || spec.defaultRepository;
    const resolvedImage = imageRef
        || `${spec.allowedImagePrefix}:${targetVersion ? (String(targetVersion).startsWith('v') ? targetVersion : `v${targetVersion}`) : 'latest'}`;

    if (!STRICT_IMAGE_REGEX.test(resolvedImage) || !resolvedImage.startsWith(spec.allowedImagePrefix)) {
        throw new Error(`許可されていないコンテナイメージが指定されました: ${resolvedImage}`);
    }

    // 1. Optional GHCR authentication for private paid plugins
    if (process.env.GHCR_TOKEN) {
        const ghcrUser = process.env.GHCR_USERNAME || 'ea-updater';
        await execFileAsync('sh', ['-c', 'printf "%s" "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin'], {
            env: { ...process.env, GHCR_USER: ghcrUser, GHCR_TOKEN: process.env.GHCR_TOKEN },
            timeout: 20000
        });
    }

    // 2. Verify container certificate/signature via Cosign before pulling/running
    const cosignResult = await verifyCosignSignature(resolvedImage, repo);

    // 3. Pull verified image from GHCR
    console.log(`[PluginUpdater] Pulling verified image: ${resolvedImage}`);
    await runDocker(['pull', resolvedImage], 180000);

    // 4. Inspect core container for shared network & data volume
    const { networkName, hostDataMount, coreEnvMap } = await inspectCoreRuntime();

    // 5. Rename existing container for safe rollback if present
    const backupName = `${spec.containerName}-rollback-${Date.now()}`;
    const hadExisting = await containerExists(spec.containerName);
    if (hadExisting) {
        console.log(`[PluginUpdater] Backing up existing container ${spec.containerName} -> ${backupName}`);
        await runDocker(['stop', spec.containerName], 30000).catch(() => {});
        await runDocker(['rename', spec.containerName, backupName], 15000);
    }

    // 6. Start new container with strict least-privilege flags
    const runArgs = [
        'run', '-d',
        '--name', spec.containerName,
        '--restart', 'unless-stopped',
        '--network', networkName,
        '-p', `127.0.0.1:${spec.port}:${spec.port}`,
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', 'NODE_ENV=production',
        '-e', `PORT=${spec.port}`,
        '-e', 'DATA_DIR=/app/data',
        '-e', `EA_CORE_INTERNAL_URL=http://${CORE_CONTAINER_NAME}:8080`
    ];

    if (hostDataMount) {
        runArgs.push('-v', `${hostDataMount}:/app/data`);
    }

    const forwardEnvKeys = ['JWT_SECRET', 'DB_ENCRYPTION_KEY', 'GEMINI_API_KEY', 'CLAUDE_API_KEY'];
    for (const key of forwardEnvKeys) {
        const val = process.env[key] || coreEnvMap[key];
        if (val) {
            runArgs.push('-e', `${key}=${val}`);
        }
    }

    runArgs.push(resolvedImage);

    try {
        console.log(`[PluginUpdater] Starting new container ${spec.containerName} (${resolvedImage})`);
        await runDocker(runArgs, 30000);
        await waitForHealth(spec.containerName, spec.port, spec.healthPath, 30000);

        // Success: remove rollback backup container
        if (hadExisting) {
            await runDocker(['rm', '-f', backupName], 15000).catch(() => {});
        }
        await runDocker(['image', 'prune', '-f'], 30000).catch(() => {});

        return {
            ok: true,
            widgetId,
            containerName: spec.containerName,
            image: resolvedImage,
            cosign: cosignResult,
            network: networkName
        };
    } catch (deployErr) {
        console.error(`[PluginUpdater] Deployment failed for ${widgetId}, initiating rollback:`, deployErr.message);
        await runDocker(['rm', '-f', spec.containerName], 15000).catch(() => {});
        if (hadExisting) {
            await runDocker(['rename', backupName, spec.containerName], 15000).catch(() => {});
            await runDocker(['start', spec.containerName], 20000).catch(() => {});
        }
        throw new Error(`コンテナ起動に失敗したため自動ロールバックしました: ${deployErr.message}`);
    }
}

async function uninstallWidgetContainer(widgetId) {
    const spec = WIDGET_RUNTIME_REGISTRY[widgetId];
    if (!spec) {
        throw new Error(`Unsupported or unauthorized widgetId: ${widgetId}`);
    }
    if (await containerExists(spec.containerName)) {
        await runDocker(['rm', '-f', spec.containerName], 20000);
    }
    return { ok: true, widgetId, containerName: spec.containerName, removed: true };
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/health') {
            return sendJson(res, 200, {
                status: 'ok',
                service: 'ea-plugin-updater',
                verifyCosign: VERIFY_COSIGN,
                managedWidgets: Object.keys(WIDGET_RUNTIME_REGISTRY)
            });
        }

        try {
            verifyA2AToken(req);
        } catch (authErr) {
            return sendJson(res, 401, { error: `Unauthorized: ${authErr.message}` });
        }

        if (req.method === 'POST' && (req.url === '/install' || req.url === '/update')) {
            const body = await readJsonBody(req);
            const result = await deployWidgetContainer({
                widgetId: body.widgetId,
                targetVersion: body.targetVersion,
                imageRef: body.imageRef,
                repository: body.repository
            });
            return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && req.url === '/uninstall') {
            const body = await readJsonBody(req);
            const result = await uninstallWidgetContainer(body.widgetId);
            return sendJson(res, 200, result);
        }

        return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error('[PluginUpdater] Request error:', err.message);
        return sendJson(res, 500, { error: err.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[PluginUpdater] Listening on 0.0.0.0:${PORT} (core=${CORE_CONTAINER_NAME}, verifyCosign=${VERIFY_COSIGN})`);
});
