# MacOSUI-Community AWS Execution Environment Backup Manifest

- **Backup Date**: 2026-11-12
- **Source Host**: AWS EC2 (`i-0c394bc0196be22fe` / `MacOSUI-Test-EC2` / `54.250.184.86`)
- **Git Repository**: `https://github.com/Techies-T/MacOSUI-Community.git`
- **Git Commit**: `4efed99` (fix(ui): check passkeySupported before showing passkey unlock button on non-passkey devices)

## Saved Docker Images
1. `macosui-community-latest-4efed99-20261112.tar.gz` (128.5 MiB)
   - Image Name: `repo-macosui:latest`
   - Image ID: `f1d61b9ac937`
   - Role: MacOSUI Community Web / Backend Core Container

2. `techies-t-zta-mcp-gateway-latest-20261112.tar.gz` (88.9 MiB)
   - Image Name: `techies-t/zta-mcp-gateway:latest`
   - Image ID: `a9d55ba4fb6f`
   - Role: ZTA MCP Gateway

3. `techies-t-admin-procedures-mcp-latest-20261112.tar.gz` (140.3 MiB)
   - Image Name: `techies-t/admin-procedures-mcp:latest`
   - Image ID: `0c52ddb1f034`
   - Role: Administrative Procedures MCP Server

4. `techies-t-mariadb-mcp-latest-20261112.tar.gz` (48.5 MiB)
   - Image Name: `techies-t/mariadb-mcp:latest`
   - Image ID: `03af68b70d6a`
   - Role: MariaDB MCP Server

## How to Restore / Load Images
```bash
# 1. S3からダウンロード
aws s3 cp s3://macosui-backups-843109109185/docker-images/macosui-community-latest-4efed99-20261112.tar.gz .

# 2. Dockerイメージとしてロード
gunzip -c macosui-community-latest-4efed99-20261112.tar.gz | docker load

# 3. ロード確認
docker images repo-macosui:latest
```
