#!/usr/bin/env bash
# ==============================================================================
# Built-in Quality Automated Deployment Script for Staging (Sakura VPS)
# ==============================================================================
set -e

echo "🔒 [Step 1/4] Node.js Package Security Check (npm audit)..."
npm audit --audit-level=critical

echo "🐳 [Step 2/4] Docker Scout Container Vulnerability Scan..."
docker build --no-cache -t macosui-staging-test .
docker scout cves macosui-staging-test --exit-code --only-severity critical

echo "🚀 [Step 3/4] Pushing to Staging Branch..."
git push origin staging

echo "⏳ [Step 4/4] Verifying Remote Container Recreation & Health Check..."
sleep 45
ssh -i ~/.ssh/id_ed25519_vps -o StrictHostKeyChecking=no debian@<YOUR_STAGING_VPS_IP> "docker ps"
curl -s https://macosui-staging.techiespod.co.jp/api/health
echo ""
echo "✅ [SUCCESS] Deployment pipeline completed successfully with verified security checks!"
