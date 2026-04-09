# Infoniqadashboard – Express.js
# Simple single-stage image: no build step required.
#
# Build:  docker build -t infoniqadashboard .
# Run:    docker run -p 3000:3000 --env-file .env infoniqadashboard

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat curl wget
WORKDIR /app

# Install production dependencies first (layer cache)
COPY app/package.json app/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy application source
COPY app/server.js ./
COPY app/src/ ./src/
COPY app/public/ ./public/

# Runtime config scaffold – actual values come from environment variables
# config.json is copied read-only; .token and cache are NOT included
COPY app/data/config.json ./data/config.json

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nodeapp \
 && chown -R nodeapp:nodejs /app
USER nodeapp

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/status || exit 1

CMD ["node", "server.js"]
