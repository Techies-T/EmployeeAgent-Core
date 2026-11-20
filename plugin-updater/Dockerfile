FROM node:24-alpine

WORKDIR /app

# Install Docker CLI + curl + cosign (for Sigstore container signature verification)
RUN apk add --no-cache docker-cli curl \
    && (apk add --no-cache cosign || true)

COPY package.json ./
RUN npm install --omit=dev

COPY server.cjs ./

ENV NODE_ENV=production
ENV PORT=8099
ENV CORE_CONTAINER_NAME=macosui-local
ENV VERIFY_COSIGN=true

EXPOSE 8099

CMD ["node", "server.cjs"]
