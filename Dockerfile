# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build || yarn build || pnpm build

# --- Runtime stage ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV CACHE_DIR=/data
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server/index.js"]


