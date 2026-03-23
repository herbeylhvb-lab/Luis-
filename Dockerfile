# ---- Stage 1: Build native modules ----
# Pin exact version so both stages share the same Node ABI (critical for native addons)
FROM node:20.19-slim AS builder

# Install build tools for better-sqlite3 (native C++ addon)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy ONLY package files first — this layer is cached unless deps change
COPY package.json package-lock.json ./

# Use npm ci for faster, deterministic installs (respects lockfile exactly)
RUN npm ci --omit=dev

# ---- Stage 2: Production image (smaller, no build tools) ----
FROM node:20.19-slim

WORKDIR /app

# Copy built node_modules from builder stage (no gcc/make in final image)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source code (this layer changes most often — last!)
COPY package.json ./
COPY server.js ./
COPY db.js ./
COPY routes/ ./routes/
COPY public/ ./public/

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Railway injects PORT env var automatically
EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
