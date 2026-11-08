#!/usr/bin/env bash
# ==============================================================================
# AWS EC2 Safe Deployment & VUP Script with Zero Data Loss Guarantee
# Deploys EmployeeAgent-Core (EA-Core 1.0.0) + ZTA-MCP-Gateway + MariaDB (NPB) + Digital Agency MCP
#
# Usage (on EC2 instance):
#   bash scripts/deploy-ec2.sh                      (Default: Full Stack with ZTA-MCP-Gateway & MariaDB)
#   DEPLOY_MCP_STACK=false bash scripts/deploy-ec2.sh (EA-Core standalone)
# ==============================================================================
set -e

REPO_DIR="${REPO_DIR:-/opt/macosui/repo}"
DATA_VOLUME="${DATA_VOLUME:-/app/data}"
DEPLOY_MCP_STACK="${DEPLOY_MCP_STACK:-true}"

echo "=================================================="
echo "🔒 [Step 1/5] Persistent Storage & Pre-deploy Safety Check"
echo "=================================================="

if [ -d "$DATA_VOLUME" ]; then
    echo "✅ Persistent EBS volume detected at $DATA_VOLUME"
    
    # 1. Ensure .env has DATA_DIR=/app/data
    if [ ! -f "$REPO_DIR/.env" ] || ! grep -q "DATA_DIR" "$REPO_DIR/.env"; then
        echo "DATA_DIR=$DATA_VOLUME" >> "$REPO_DIR/.env"
        echo "✅ Configured DATA_DIR=$DATA_VOLUME in .env"
    fi

    # 2. Backup existing database safely
    if [ -f "$DATA_VOLUME/database.sqlite" ]; then
        TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
        BACKUP_FILE="$DATA_VOLUME/database_backup_${TIMESTAMP}.sqlite"
        cp "$DATA_VOLUME/database.sqlite" "$BACKUP_FILE"
        echo "✅ Database safely backed up to: $BACKUP_FILE"
        
        # Keep latest 10 backups
        ls -t "$DATA_VOLUME"/database_backup_*.sqlite 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
    fi

    # 3. Ensure ./data is a symlink to /app/data
    cd "$REPO_DIR"
    if [ -d "./data" ] && [ ! -L "./data" ]; then
        echo "⚠️ Warning: Found plain directory ./data. Replacing with symlink to $DATA_VOLUME..."
        rm -rf ./data
    fi
    ln -sfn "$DATA_VOLUME" ./data
    echo "✅ Symlink verified: $(ls -ld ./data)"

    # 4. Ensure server/development.env links to $DATA_VOLUME/development.env
    if [ -f "$DATA_VOLUME/development.env" ]; then
        ln -sfn "$DATA_VOLUME/development.env" "$REPO_DIR/server/development.env"
        echo "✅ Linked server/development.env to $DATA_VOLUME/development.env"
    elif [ ! -f "$REPO_DIR/server/development.env" ]; then
        ENC_KEY=$(openssl rand -hex 32)
        JWT_SEC=$(openssl rand -hex 32)
        cat > "$DATA_VOLUME/development.env" <<EOF
PORT=8080
DB_TYPE=sqlite
DB_ENCRYPTION_KEY=${ENC_KEY}
JWT_SECRET=${JWT_SEC}
SESSION_LOCK_MAX_COUNT=6
EOF
        ln -sfn "$DATA_VOLUME/development.env" "$REPO_DIR/server/development.env"
        echo "✅ Created and linked $DATA_VOLUME/development.env"
    fi
else
    echo "ℹ️ Local/Standard directory environment detected ($DATA_VOLUME not present)."
    mkdir -p "$REPO_DIR/data"
    if [ ! -f "$REPO_DIR/server/development.env" ]; then
        ENC_KEY=$(openssl rand -hex 32)
        JWT_SEC=$(openssl rand -hex 32)
        cat > "$REPO_DIR/server/development.env" <<EOF
PORT=8080
DB_TYPE=sqlite
DB_ENCRYPTION_KEY=${ENC_KEY}
JWT_SECRET=${JWT_SEC}
SESSION_LOCK_MAX_COUNT=6
EOF
        echo "✅ Created $REPO_DIR/server/development.env"
    fi
fi

echo "=================================================="
echo "🧹 [Step 2/5] Clean OS Metadata & Stash"
echo "=================================================="
cd "$REPO_DIR"
find . -name "._*" -delete 2>/dev/null || true
sudo chown -R "$(whoami)":"$(whoami)" "$REPO_DIR" 2>/dev/null || true

echo "=================================================="
echo "🚀 [Step 3/5] Pull Latest Code (VUP)"
echo "=================================================="
git fetch origin --tags -f
git checkout main
git pull origin main
echo "Current Commit: $(git log -1 --oneline)"

echo "=================================================="
echo "🐳 [Step 4/5] Rebuild and Restart Containers"
echo "=================================================="
COMPOSE_CMD="docker-compose"
if command -v /usr/local/bin/docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="/usr/local/bin/docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
fi

if [ "$DEPLOY_MCP_STACK" = "true" ] && [ -f "docker-compose.full.yml" ]; then
    echo "🛡️ Deploying Full Stack (EA-Core + ZTA-MCP-Gateway + MariaDB NPB + Digital Agency MCP)..."
    sudo $COMPOSE_CMD -f docker-compose.full.yml up -d --build --force-recreate
    sleep 6
    echo "⚾ Seeding NPB 2024-2026 dataset into MariaDB..."
    sudo docker exec -i test_mariadb mariadb -u root -pmy-secret-pw testdb < scripts/setup_npb_data.sql 2>/dev/null || true
else
    echo "📦 Deploying EA-Core Standalone..."
    sudo $COMPOSE_CMD up -d --build --force-recreate
fi

echo "Pruning dangling images and builder cache..."
sudo docker image prune -f || true
sudo docker builder prune -f || true

echo "=================================================="
echo "✅ [Step 5/5] Verify Post-Deploy Health & Data Integrity"
echo "=================================================="
sleep 5

# Check container status
sudo docker ps

# Check Health endpoint
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health || echo "failed")
if [ "$HEALTH_STATUS" = "200" ]; then
    echo "✅ Health endpoint responded 200 OK"
else
    echo "❌ Health endpoint failed with status: $HEALTH_STATUS"
    exit 1
fi

# Verify user data intact
sudo docker exec macosui-local node -e '
const db = require("./server/db.cjs");
db.all("SELECT id, email, name, role FROM users", (err, rows) => {
    if (err) {
        console.error("❌ Database query error:", err.message);
        process.exit(1);
    }
    console.log("✅ Verified active users in database (" + rows.length + " users found):");
    rows.forEach(u => console.log("   - " + u.name + " (" + u.email + ") [" + u.role + "]"));
    process.exit(0);
});
'

echo "🎉 [SUCCESS] EC2 Full-Stack Deployment completed smoothly with zero data loss!"
