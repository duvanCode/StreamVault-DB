# ==============================================================================
# StreamVault DB - Dockerfile for Dokploy & VPS Deployment
# Multi-database backup streaming to Google Drive with Zero VPS Disk overhead
# ==============================================================================

FROM node:22-alpine

# Set environment
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# Install native database client utilities, compression tools & curl for healthcheck
# - postgresql16-client: provides pg_dump, pg_restore, psql
# - mysql-client / mariadb-client: provides mysqldump, mysql
# - gzip: fast on-the-fly streaming compression
# - tzdata: timezone support for accurate cron scheduling
RUN apk update && \
    apk add --no-cache \
      postgresql16-client \
      mysql-client \
      gzip \
      bash \
      curl \
      tzdata \
      ca-certificates && \
    rm -rf /var/cache/apk/*

WORKDIR /app

# Ensure persistent data directory exists
RUN mkdir -p /app/data

# Install node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose Web Dashboard Port
EXPOSE 3000

# Docker / Dokploy Healthcheck with dynamic PORT support
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD sh -c 'curl -f "http://localhost:${PORT:-3000}/api/health" || exit 1'

# Start service
CMD ["node", "src/server.js"]
