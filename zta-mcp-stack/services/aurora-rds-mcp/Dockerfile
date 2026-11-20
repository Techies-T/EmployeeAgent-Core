FROM node:20-alpine

ARG ENABLE_AWSLABS_MYSQL=false

WORKDIR /app

# Install CA certificates and curl; download Amazon RDS global CA bundle for TLS verification
RUN apk add --no-cache ca-certificates curl \
    && mkdir -p /etc/ssl/certs \
    && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /etc/ssl/certs/rds-global-bundle.pem \
    && chmod 644 /etc/ssl/certs/rds-global-bundle.pem

# Optional: Install uv / uvx to support DB_AUTH_MODE=awslabs_mysql (awslabs.mysql-mcp-server bridge)
RUN if [ "$ENABLE_AWSLABS_MYSQL" = "true" ]; then \
      apk add --no-cache python3 py3-pip && \
      curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; \
    fi

# Install Node.js production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Security: run as non-root user
USER node

EXPOSE 33080

ENV NODE_ENV=production
ENV MCP_PORT=33080
ENV MCP_HOST=0.0.0.0
ENV DB_AUTH_MODE=sandbox_sim
ENV DB_READ_ONLY=true
ENV DB_SSL_CA_PATH=/etc/ssl/certs/rds-global-bundle.pem

CMD ["node", "src/server.cjs"]
