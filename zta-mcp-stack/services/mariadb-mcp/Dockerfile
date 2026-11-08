FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Security: run as non-root user
USER node

EXPOSE 33060

ENV NODE_ENV=production
ENV MCP_PORT=33060

CMD ["node", "src/http-server.js"]
