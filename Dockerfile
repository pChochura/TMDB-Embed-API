# ---------- Build Stage ----------
FROM node:20-alpine AS build
ARG VERSION=dev
WORKDIR /app

# Install only production dependencies first (leveraging cache)
COPY package.json package-lock.json ./
# Using npm install instead of npm ci because lock file appears out-of-sync
# If you later regenerate lock (npm install locally) you can revert to npm ci for reproducibility
RUN npm install --omit=dev

# Copy only required source (avoid sending screenshots, node_modules already installed)
COPY apiServer.js ./
COPY providers ./providers
COPY proxy ./proxy
COPY public ./public
COPY utils ./utils
COPY routes ./routes
COPY db ./db
COPY README.md ./

# ---------- Runtime Stage ----------
FROM node:20-alpine AS runtime
ARG VERSION=dev
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=8787 \
    BIND_HOST=0.0.0.0 \
    APP_VERSION=${VERSION}

# Browser-backed providers use the system Chromium rather than downloading a browser.
# su-exec allows entrypoint to run root volume setup and drop privileges to app user.
RUN apk add --no-cache chromium su-exec

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy node_modules from build and necessary source
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apiServer.js ./
COPY --from=build /app/public ./public
COPY --from=build /app/providers ./providers
COPY --from=build /app/proxy ./proxy
COPY --from=build /app/utils ./utils
COPY --from=build /app/routes ./routes
COPY --from=build /app/db ./db
COPY --from=build /app/package.json ./
COPY --from=build /app/README.md ./
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R app:app /app

# Expose port (documentational; runtime can override)
EXPOSE 8787

# Labels / metadata
LABEL org.opencontainers.image.title="TMDB Embed API" \
    org.opencontainers.image.description="Streaming metadata + source aggregation API with multi-key TMDB rotation" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.source="https://github.com/Inside4ndroid/TMDB-Embed-API" \
    org.opencontainers.image.licenses="MIT"

# Healthcheck (simple)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${API_PORT:-8787}/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node","apiServer.js"]
