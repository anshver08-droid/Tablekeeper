# Production Dockerfile for TableKeeper
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/copy-assets.mjs ./scripts/
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/

EXPOSE 3000

CMD ["node", "dist/src/server.js"]
