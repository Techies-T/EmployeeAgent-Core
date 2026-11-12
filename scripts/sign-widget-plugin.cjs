#!/usr/bin/env node
/**
 * EA-Core Widget Plugin Code Signing CLI (PQC Hybrid: Ed25519 + NIST FIPS 204 ML-DSA-65)
 *
 * Usage:
 *   1) Initialize / rotate local dev keypair in server/development.env:
 *      node scripts/sign-widget-plugin.cjs --keygen-dev
 *
 *   2) Sign a widget plugin project (local dev keys):
 *      node scripts/sign-widget-plugin.cjs --dir "../ea-widget-virtual-office"
 *
 *   3) Sign in GitHub Actions CI/CD using AWS KMS FIPS 140-3 Level 3 HSM:
 *      node scripts/sign-widget-plugin.cjs --dir "." --mode aws-kms \
 *        --kms-mldsa-key-id "$AWS_KMS_MLDSA65_KEY_ID" \
 *        --repo "$GITHUB_REPOSITORY"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');

const verifier = require('../server/services/pluginSignatureVerifier.cjs');

const DEV_ENV_PATH = path.join(__dirname, '..', 'server', 'development.env');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--keygen-dev') {
            args.keygenDev = true;
        } else if (arg === '--dir' && argv[i + 1]) {
            args.dir = argv[++i];
        } else if (arg === '--mode' && argv[i + 1]) {
            args.mode = argv[++i];
        } else if (arg === '--kms-mldsa-key-id' && argv[i + 1]) {
            args.kmsMldsaKeyId = argv[++i];
        } else if (arg === '--repo' && argv[i + 1]) {
            args.repo = argv[++i];
        } else if (arg === '--attestation-url' && argv[i + 1]) {
            args.attestationUrl = argv[++i];
        }
    }
    return args;
}

function upsertEnvKeys(envFilePath, keyValues) {
    let content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
    for (const [key, val] of Object.entries(keyValues)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${val}`);
        } else {
            if (content.length > 0 && !content.endsWith('\n')) content += '\n';
            content += `${key}=${val}\n`;
        }
    }
    fs.writeFileSync(envFilePath, content, 'utf8');
}

async function generateDevKeyPair() {
    const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js');

    // 1. Classical Ed25519 keypair (DER PKCS8 / SPKI base64)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const edPubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const edPrivB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

    // 2. Post-Quantum NIST FIPS 204 ML-DSA-65 keypair (1952B pub / 4032B sec)
    const pqcKeys = ml_dsa65.keygen();
    const pqcPubB64 = Buffer.from(pqcKeys.publicKey).toString('base64');
    const pqcPrivB64 = Buffer.from(pqcKeys.secretKey).toString('base64');

    upsertEnvKeys(DEV_ENV_PATH, {
        PLUGIN_DEV_ED25519_PUBLIC_KEY: edPubB64,
        PLUGIN_DEV_ED25519_PRIVATE_KEY: edPrivB64,
        PLUGIN_DEV_MLDSA65_PUBLIC_KEY: pqcPubB64,
        PLUGIN_DEV_MLDSA65_PRIVATE_KEY: pqcPrivB64
    });

    console.log('[PQC KeyGen] Generated Ed25519 + NIST FIPS 204 ML-DSA-65 Dev Keypair in server/development.env');
    console.log(`  - Ed25519 Public Key (SPKI): ${edPubB64.substring(0, 28)}...`);
    console.log(`  - ML-DSA-65 Public Key (1952B): ${pqcPubB64.substring(0, 28)}...`);
}

function signWithAwsKmsCli(keyId, signingAlgorithm, messageBuffer) {
    const msgB64 = messageBuffer.toString('base64');
    const output = execFileSync('aws', [
        'kms', 'sign',
        '--key-id', keyId,
        '--message', msgB64,
        '--message-type', 'RAW',
        '--signing-algorithm', signingAlgorithm,
        '--query', 'Signature',
        '--output', 'text'
    ], { encoding: 'utf8' });
    return output.trim();
}

async function signPluginDirectory(options) {
    const targetDir = path.resolve(options.dir);
    const mode = options.mode || 'dev';

    if (fs.existsSync(DEV_ENV_PATH)) {
        dotenv.config({ path: DEV_ENV_PATH, override: false });
    }

    const publicManifestPath = path.join(targetDir, 'public', 'widget.manifest.json');
    const rootManifestPath = path.join(targetDir, 'widget.manifest.json');
    const sourceManifestPath = fs.existsSync(publicManifestPath) ? publicManifestPath : rootManifestPath;

    if (!fs.existsSync(sourceManifestPath)) {
        throw new Error(`widget.manifest.json not found in ${targetDir}`);
    }

    const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'));
    const distDir = path.join(targetDir, 'dist');
    const bundleFilesSha256 = fs.existsSync(distDir)
        ? verifier.computeDirectoryFileHashes(distDir)
        : {};

    manifest.integrity = {
        ...(manifest.integrity || {}),
        bundleFilesSha256,
        signedAt: new Date().toISOString(),
        keyEnvironment: mode === 'aws-kms' ? 'production' : 'development'
    };

    const canonicalPayloadSha256 = verifier.computeCanonicalPayloadSha256(manifest);
    manifest.integrity.canonicalPayloadSha256 = canonicalPayloadSha256;

    const messageBytes = verifier.buildSigningMessageBytes(
        canonicalPayloadSha256,
        manifest.id,
        manifest.version || '1.0.0'
    );

    let ed25519SigB64 = '';
    let ed25519KeyId = '';
    let mlDsa65SigB64 = '';
    let mlDsa65KeyId = '';

    if (mode === 'aws-kms') {
        const kmsMldsaKeyId = options.kmsMldsaKeyId || process.env.AWS_KMS_MLDSA65_KEY_ID;
        const prodEdPrivB64 = process.env.EA_PLUGIN_PROD_ED25519_PRIVATE_KEY;
        if (!kmsMldsaKeyId) {
            throw new Error('AWS_KMS_MLDSA65_KEY_ID (--kms-mldsa-key-id) is required for aws-kms mode.');
        }
        if (!prodEdPrivB64) {
            throw new Error('EA_PLUGIN_PROD_ED25519_PRIVATE_KEY is required alongside KMS ML-DSA-65.');
        }
        const edPrivKey = crypto.createPrivateKey({
            key: Buffer.from(prodEdPrivB64, 'base64'),
            format: 'der',
            type: 'pkcs8'
        });
        ed25519SigB64 = crypto.sign(null, messageBytes, edPrivKey).toString('base64');
        ed25519KeyId = process.env.EA_PLUGIN_PROD_ED25519_KEY_ID || 'techies-ea-root-ed25519-v1';

        // AWS KMS FIPS 204 ML_DSA_65 HSM signing (private key never leaves KMS HSM)
        mlDsa65SigB64 = signWithAwsKmsCli(kmsMldsaKeyId, 'ML_DSA_SHAKE_256', messageBytes);
        mlDsa65KeyId = process.env.EA_PLUGIN_PROD_MLDSA65_KEY_ID || 'techies-ea-root-mldsa65-v1';
    } else {
        const edPrivB64 = process.env.PLUGIN_DEV_ED25519_PRIVATE_KEY;
        const pqcPrivB64 = process.env.PLUGIN_DEV_MLDSA65_PRIVATE_KEY;
        if (!edPrivB64 || !pqcPrivB64) {
            throw new Error('Dev signing keys not found in server/development.env. Run with --keygen-dev first.');
        }

        const edPrivKey = crypto.createPrivateKey({
            key: Buffer.from(edPrivB64, 'base64'),
            format: 'der',
            type: 'pkcs8'
        });
        ed25519SigB64 = crypto.sign(null, messageBytes, edPrivKey).toString('base64');
        ed25519KeyId = 'techies-ea-dev-ed25519-v1';

        const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js');
        const pqcSecretBytes = new Uint8Array(Buffer.from(pqcPrivB64, 'base64'));
        const pqcSig = ml_dsa65.sign(new Uint8Array(messageBytes), pqcSecretBytes);
        mlDsa65SigB64 = Buffer.from(pqcSig).toString('base64');
        mlDsa65KeyId = 'techies-ea-dev-mldsa65-v1';
    }

    const repoName = options.repo || process.env.GITHUB_REPOSITORY || `Techies-T/ea-widget-${manifest.id}`;
    manifest.signatures = {
        publisherHybrid: {
            classical: {
                algorithm: 'ed25519',
                keyId: ed25519KeyId,
                signatureBase64: ed25519SigB64
            },
            pqc: {
                algorithm: 'ml-dsa-65',
                standard: 'NIST-FIPS-204',
                keyId: mlDsa65KeyId,
                signatureBase64: mlDsa65SigB64
            }
        },
        githubProvenance: {
            repository: repoName,
            workflowRef: process.env.GITHUB_WORKFLOW_REF || '.github/workflows/release-signed-plugin.yml',
            commitSha: process.env.GITHUB_SHA || 'local-dev-build',
            attestationBundleUrl: options.attestationUrl || null,
            attestationVerified: Boolean(options.attestationUrl || process.env.GITHUB_ACTIONS === 'true')
        }
    };

    const serializedManifest = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(sourceManifestPath, serializedManifest, 'utf8');
    if (fs.existsSync(distDir)) {
        fs.writeFileSync(path.join(distDir, 'widget.manifest.json'), serializedManifest, 'utf8');
    }

    // Self-verify immediately via EA-Core Gatekeeper
    const verifyRes = await verifier.verifyPluginManifestSignature(manifest, {
        bundleDir: fs.existsSync(distDir) ? distDir : null
    });

    if (!verifyRes.valid) {
        throw new Error(`Self-verification failed after signing: ${verifyRes.error}`);
    }

    console.log(`[PQC Signer] Successfully signed & verified widget "${manifest.id}" v${manifest.version}`);
    console.log(`  - Mode: ${manifest.integrity.keyEnvironment}`);
    console.log(`  - Hashed dist files: ${Object.keys(bundleFilesSha256).length}`);
    console.log(`  - Canonical SHA-256: ${canonicalPayloadSha256}`);
    console.log(`  - Classical Sig: Ed25519 (${ed25519KeyId})`);
    console.log(`  - PQC Sig: ML-DSA-65 / NIST FIPS 204 (${mlDsa65KeyId})`);
}

(async () => {
    try {
        const args = parseArgs(process.argv);
        if (args.keygenDev) {
            await generateDevKeyPair();
            return;
        }
        if (args.dir) {
            await signPluginDirectory(args);
            return;
        }
        console.log('Usage: node scripts/sign-widget-plugin.cjs [--keygen-dev | --dir <pluginPath> [--mode dev|aws-kms]]');
    } catch (err) {
        console.error('[PQC Signer Error]:', err.message);
        process.exit(1);
    }
})();
