# --- Build stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- Runtime stage ---
FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV CACHE_DIR=/data/cache
ENV AUTH_DIR=/data/auth
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data/cache /data/auth && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]

