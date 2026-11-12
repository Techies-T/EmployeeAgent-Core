const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

// Ensure development.env is loaded in non-production environments for Dev Key verification
const devEnvPath = path.join(__dirname, '..', 'development.env');
if (process.env.NODE_ENV !== 'production' && fs.existsSync(devEnvPath)) {
    dotenv.config({ path: devEnvPath, override: false });
}

let cachedMlDsa65 = null;
async function getMlDsa65() {
    if (!cachedMlDsa65) {
        const mod = await import('@noble/post-quantum/ml-dsa.js');
        cachedMlDsa65 = mod.ml_dsa65;
    }
    return cachedMlDsa65;
}

/**
 * Deterministic recursive key-sorted JSON serializer for canonical manifest hashing.
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const k of keys) {
        if (value[k] === undefined) continue;
        entries.push(`${JSON.stringify(k)}:${stableStringify(value[k])}`);
    }
    return `{${entries.join(',')}}`;
}

/**
 * Extract security-relevant fields of widget.manifest.json for canonical digest calculation.
 * Transient runtime properties (installedAt, signatures, runtime status) are excluded.
 */
function buildCanonicalManifestObject(manifest = {}) {
    return {
        id: manifest.id || '',
        packageId: manifest.packageId || '',
        name: manifest.name || '',
        englishName: manifest.englishName || '',
        version: manifest.version || '1.0.0',
        category: manifest.category || 'addon',
        entrypoints: manifest.entrypoints || {},
        windowConfig: manifest.windowConfig || {},
        providesCapabilities: Array.isArray(manifest.providesCapabilities) ? manifest.providesCapabilities : [],
        consumesCapabilities: Array.isArray(manifest.consumesCapabilities) ? manifest.consumesCapabilities : [],
        permissionsSchema: manifest.permissionsSchema || {},
        bundleFilesSha256: manifest.integrity?.bundleFilesSha256 || {}
    };
}

/**
 * Compute SHA-256 hex digest of the canonical manifest payload.
 */
function computeCanonicalPayloadSha256(manifest) {
    const canonicalObj = buildCanonicalManifestObject(manifest);
    const serialized = stableStringify(canonicalObj);
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compute recursive SHA-256 file map of a plugin build directory (e.g. dist/),
 * skipping widget.manifest.json itself to avoid circular self-hashing.
 */
function computeDirectoryFileHashes(rootDir) {
    const fileHashes = {};
    if (!rootDir || !fs.existsSync(rootDir)) {
        return fileHashes;
    }

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && relPath !== 'widget.manifest.json' && relPath !== 'manifest.json') {
                const buf = fs.readFileSync(fullPath);
                fileHashes[relPath] = crypto.createHash('sha256').update(buf).digest('hex');
            }
        }
    }

    walk(rootDir);
    return fileHashes;
}

/**
 * Build the exact signing message bytes from the canonical payload SHA-256 digest.
 */
function buildSigningMessageBytes(canonicalPayloadSha256, widgetId, version) {
    const domainSeparatedString = `EA-CORE-PLUGIN-SIGNATURE-V1|id=${widgetId}|ver=${version}|sha256=${canonicalPayloadSha256}`;
    return Buffer.from(domainSeparatedString, 'utf8');
}

/**
 * Resolve trusted public keys (Production AWS KMS Root Public Keys + optional Dev Keys in non-production).
 */
function getTrustedKeyRing() {
    const isProd = process.env.NODE_ENV === 'production' && process.env.ALLOW_PLUGIN_DEV_KEYS !== 'true';
    const trustedGithubOrgs = (process.env.TRUSTED_PLUGIN_GITHUB_ORGS || 'Techies-T,minoru-inui')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const keys = {};

    // 1. Production Publisher Public Keys (Exported from AWS KMS Asymmetric Keys: Ed25519/ECDSA & FIPS 204 ML_DSA_65)
    if (process.env.EA_PLUGIN_PROD_ED25519_PUBLIC_KEY && process.env.EA_PLUGIN_PROD_MLDSA65_PUBLIC_KEY) {
        keys['techies-ea-prod-v1'] = {
            environment: 'production',
            ed25519KeyId: process.env.EA_PLUGIN_PROD_ED25519_KEY_ID || 'techies-ea-root-ed25519-v1',
            ed25519PublicKeySpkiB64: process.env.EA_PLUGIN_PROD_ED25519_PUBLIC_KEY,
            mlDsa65KeyId: process.env.EA_PLUGIN_PROD_MLDSA65_KEY_ID || 'techies-ea-root-mldsa65-v1',
            mlDsa65PublicKeyB64: process.env.EA_PLUGIN_PROD_MLDSA65_PUBLIC_KEY
        };
    }

    // 2. Development Keys (Loaded ONLY from server/development.env when not in strict production)
    if (!isProd && process.env.PLUGIN_DEV_ED25519_PUBLIC_KEY && process.env.PLUGIN_DEV_MLDSA65_PUBLIC_KEY) {
        keys['techies-ea-dev-v1'] = {
            environment: 'development',
            ed25519KeyId: 'techies-ea-dev-ed25519-v1',
            ed25519PublicKeySpkiB64: process.env.PLUGIN_DEV_ED25519_PUBLIC_KEY,
            mlDsa65KeyId: 'techies-ea-dev-mldsa65-v1',
            mlDsa65PublicKeyB64: process.env.PLUGIN_DEV_MLDSA65_PUBLIC_KEY
        };
    }

    return {
        isProd,
        trustedGithubOrgs,
        keys
    };
}

/**
 * Verify both Classical (Ed25519) + Post-Quantum (NIST FIPS 204 ML-DSA-65) signatures
 * AND optional bundle file hashes & GitHub Build Provenance metadata.
 *
 * @param {object} manifest Parsed widget.manifest.json
 * @param {object} options { bundleDir?: string }
 * @returns {Promise<{ valid: boolean, error?: string, details: object }>}
 */
async function verifyPluginManifestSignature(manifest, options = {}) {
    const { bundleDir = null } = options;

    if (!manifest || typeof manifest !== 'object' || !manifest.id) {
        return {
            valid: false,
            error: 'プラグインマニフェストの形式が不正です（id が存在しません）。',
            details: { reason: 'invalid_manifest_structure' }
        };
    }

    const integrity = manifest.integrity;
    const hybridSig = manifest.signatures?.publisherHybrid;
    if (!integrity || !integrity.canonicalPayloadSha256 || !hybridSig?.classical || !hybridSig?.pqc) {
        return {
            valid: false,
            error: 'プラグインに当社 PQC ハイブリッド電子署名（Ed25519 + ML-DSA-65）が付与されていません。未署名のサードパーティコードはブロックされました。',
            details: { reason: 'missing_hybrid_signature', widgetId: manifest.id }
        };
    }

    // Step 1: Verify canonical manifest hash matches contents
    const expectedCanonicalHash = computeCanonicalPayloadSha256(manifest);
    if (integrity.canonicalPayloadSha256 !== expectedCanonicalHash) {
        return {
            valid: false,
            error: 'マニフェストの改ざんが検知されました（Canonical SHA-256 ダイジェスト不一致）。',
            details: {
                reason: 'manifest_digest_mismatch',
                widgetId: manifest.id,
                expected: expectedCanonicalHash,
                actual: integrity.canonicalPayloadSha256
            }
        };
    }

    // Step 2: If local/extracted bundleDir is supplied, verify every asset file's SHA-256
    if (bundleDir && fs.existsSync(bundleDir)) {
        const expectedFiles = integrity.bundleFilesSha256 || {};
        const actualFiles = computeDirectoryFileHashes(bundleDir);
        const expectedKeys = Object.keys(expectedFiles).sort();
        const actualKeys = Object.keys(actualFiles).sort();

        if (expectedKeys.length > 0) {
            if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
                return {
                    valid: false,
                    error: 'プラグインバンドル内のファイル構成が署名時と異なります（不正ファイルの混入または欠損を検知）。',
                    details: {
                        reason: 'bundle_file_list_mismatch',
                        widgetId: manifest.id,
                        expectedCount: expectedKeys.length,
                        actualCount: actualKeys.length
                    }
                };
            }
            for (const relFile of expectedKeys) {
                if (expectedFiles[relFile] !== actualFiles[relFile]) {
                    return {
                        valid: false,
                        error: `プラグインファイル「${relFile}」の改ざんが検知されました（SHA-256 不一致）。`,
                        details: {
                            reason: 'bundle_file_hash_mismatch',
                            widgetId: manifest.id,
                            tamperedFile: relFile
                        }
                    };
                }
            }
        }
    }

    // Step 3: Select matching trusted public key pair from KeyRing
    const { isProd, trustedGithubOrgs, keys } = getTrustedKeyRing();
    const keyEnv = integrity.keyEnvironment === 'production' ? 'production' : 'development';

    if (isProd && keyEnv !== 'production') {
        return {
            valid: false,
            error: '本番環境では開発用署名キー（Dev Key）で署名されたプラグインは許可されません。AWS KMS 本番署名が必要です。',
            details: { reason: 'dev_key_rejected_in_production', widgetId: manifest.id }
        };
    }

    const ringEntry = keyEnv === 'production' ? keys['techies-ea-prod-v1'] : keys['techies-ea-dev-v1'];
    if (!ringEntry) {
        return {
            valid: false,
            error: `署名検証用の公開鍵（${keyEnv}）が EA-Core に設定されていません。`,
            details: { reason: 'public_key_not_configured', keyEnvironment: keyEnv, widgetId: manifest.id }
        };
    }

    const messageBytes = buildSigningMessageBytes(
        integrity.canonicalPayloadSha256,
        manifest.id,
        manifest.version || '1.0.0'
    );

    // Step 4: Verify Classical Signature (Ed25519)
    let classicalValid = false;
    try {
        if (hybridSig.classical.algorithm !== 'ed25519') {
            throw new Error(`Unsupported classical algorithm: ${hybridSig.classical.algorithm}`);
        }
        const pubKeyDer = Buffer.from(ringEntry.ed25519PublicKeySpkiB64, 'base64');
        const publicKeyObj = crypto.createPublicKey({
            key: pubKeyDer,
            format: 'der',
            type: 'spki'
        });
        const sigBuf = Buffer.from(hybridSig.classical.signatureBase64, 'base64');
        classicalValid = crypto.verify(null, messageBytes, publicKeyObj, sigBuf);
    } catch (err) {
        return {
            valid: false,
            error: `古典暗号署名 (Ed25519) の検証中にエラーが発生しました: ${err.message}`,
            details: { reason: 'ed25519_verify_error', widgetId: manifest.id }
        };
    }

    if (!classicalValid) {
        return {
            valid: false,
            error: '古典暗号署名 (Ed25519) の検証に失敗しました。不正な署名または改ざんの可能性があります。',
            details: { reason: 'ed25519_signature_invalid', widgetId: manifest.id }
        };
    }

    // Step 5: Verify Post-Quantum Signature (NIST FIPS 204 ML-DSA-65)
    let pqcValid = false;
    try {
        if (hybridSig.pqc.algorithm !== 'ml-dsa-65') {
            throw new Error(`Unsupported PQC algorithm: ${hybridSig.pqc.algorithm}`);
        }
        const mlDsa65 = await getMlDsa65();
        const pqcPubBytes = new Uint8Array(Buffer.from(ringEntry.mlDsa65PublicKeyB64, 'base64'));
        const pqcSigBytes = new Uint8Array(Buffer.from(hybridSig.pqc.signatureBase64, 'base64'));
        const msgUint8 = new Uint8Array(messageBytes);
        pqcValid = mlDsa65.verify(pqcSigBytes, msgUint8, pqcPubBytes);
    } catch (err) {
        return {
            valid: false,
            error: `耐量子計算機暗号署名 (NIST FIPS 204 ML-DSA-65) の検証中にエラーが発生しました: ${err.message}`,
            details: { reason: 'mldsa65_verify_error', widgetId: manifest.id }
        };
    }

    if (!pqcValid) {
        return {
            valid: false,
            error: '耐量子計算機暗号署名 (NIST FIPS 204 ML-DSA-65) の検証に失敗しました。改ざんまたは偽造されたプラグインのためブロックしました。',
            details: { reason: 'mldsa65_signature_invalid', widgetId: manifest.id }
        };
    }

    // Step 6: Verify GitHub Build Provenance metadata
    const provenance = manifest.signatures?.githubProvenance || null;
    let provenanceStatus = 'unverified_local_dev';
    if (provenance && provenance.repository) {
        const [repoOwner] = String(provenance.repository).split('/');
        const isTrustedOwner = trustedGithubOrgs.includes(repoOwner);
        if (!isTrustedOwner && isProd) {
            return {
                valid: false,
                error: `信頼されていない GitHub Organization (${repoOwner}) 由来のビルド成果物です。`,
                details: { reason: 'untrusted_github_org', repository: provenance.repository }
            };
        }
        if (isTrustedOwner && provenance.attestationVerified) {
            provenanceStatus = 'github_attestation_verified';
        } else if (isTrustedOwner) {
            provenanceStatus = 'github_repo_declared';
        }
    } else if (isProd) {
        return {
            valid: false,
            error: '本番環境では GitHub Build Provenance（製造元証明）情報が必須です。',
            details: { reason: 'missing_github_provenance_in_prod', widgetId: manifest.id }
        };
    }

    return {
        valid: true,
        details: {
            widgetId: manifest.id,
            version: manifest.version || '1.0.0',
            canonicalPayloadSha256: expectedCanonicalHash,
            keyEnvironment: keyEnv,
            classicalAlgorithm: 'Ed25519',
            classicalKeyId: hybridSig.classical.keyId,
            pqcAlgorithm: 'ML-DSA-65 (NIST FIPS 204)',
            pqcKeyId: hybridSig.pqc.keyId,
            provenanceStatus,
            githubRepository: provenance?.repository || null,
            signedAt: integrity.signedAt || null,
            verifiedAt: new Date().toISOString()
        }
    };
}

module.exports = {
    stableStringify,
    buildCanonicalManifestObject,
    computeCanonicalPayloadSha256,
    computeDirectoryFileHashes,
    buildSigningMessageBytes,
    getTrustedKeyRing,
    verifyPluginManifestSignature,
    verifyPluginSignature: verifyPluginManifestSignature
};
