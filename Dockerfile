# ---- Stage 1: Build native modules ----
FROM node:20.19-slim AS builder

# Install build tools for better-sqlite3 (native C++ addon)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy ONLY package files first — this layer is cached unless deps change
COPY package.json package-lock.json ./

# Use npm ci for faster, deterministic installs (respects lockfile exactly)
# --ignore-scripts then rebuild only native addons to avoid unnecessary postinstall steps
RUN npm ci --omit=dev

# ---- Stage 2: Production image (smaller, no build tools) ----
FROM node:20.19-slim

WORKDIR /app

# Copy built node_modules from builder stage (no gcc/make in final image)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source — order from least-changed to most-changed for layer caching
COPY package.json ./
COPY server.js db.js utils.js ./
COPY routes/ ./routes/
COPY providers/ ./providers/
COPY middleware/ ./middleware/
COPY lib/ ./lib/
# Public files change most often (UI edits) — keep as last COPY
COPY public/ ./public/

ENV NODE_ENV=production
ENV DATABASE_DIR=/app/data

# Create writable directory for SQLite — Railway volume mounts at /app/data
RUN mkdir -p /app/data && chmod 777 /app/data

# Railway injects PORT env var automatically
EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
