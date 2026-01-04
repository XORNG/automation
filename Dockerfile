FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build || (echo "Build failed - check logs" && exit 1)

FROM node:18-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "dist/server.js"]

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install wget for healthcheck (not included in Alpine by default)
RUN apk add --no-cache wget

# Create non-root user
RUN addgroup -g 1001 -S xorng && \
    adduser -S xorng -u 1001 -G xorng

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R xorng:xorng /app

# Switch to non-root user
USER xorng

# Expose port
EXPOSE 3000

# Health check using node (guaranteed available, no extra install needed)
# Note: wget is now installed but using node for consistency
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info

# Start server
CMD ["node", "dist/server/server.js"]
