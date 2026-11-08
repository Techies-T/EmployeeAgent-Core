# ==============================================================================
# Stage 1: Build TypeScript source
# ==============================================================================
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for build)
COPY package.json ./
RUN npm install

# Copy source and configurations
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN npm run build

# ==============================================================================
# Stage 2: Minimal Production Runtime
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Upgrade OS packages to fix base image CVEs
RUN apk upgrade --no-cache

# Install only production dependencies
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist

# Copy default configuration
COPY config/ ./config/

# Ensure directory permissions for non-root node user
RUN chown -R node:node /app

# Switch to least-privileged user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

EXPOSE 8080

CMD ["node", "dist/index.js"]
