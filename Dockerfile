# ─────────────────────────────────────────────────────────────────────────────
# greek-competition-mcp — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t greek-competition-mcp .
# Run:    docker run --rm -p 3000:3000 greek-competition-mcp
#
# The image bakes /app/data/hcc.db at build time. Override HCC_DB_PATH
# for a custom location at runtime.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript and rebuild native bindings ---
FROM node:26-alpine AS builder

WORKDIR /app

# Native build deps for better-sqlite3 prebuild + compile fallback.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Native module rebuild — better-sqlite3's prebuild-fetch / native-compile
# postinstall hook was skipped by --ignore-scripts above. Without this, the
# .node binding is missing from node_modules and every SQLite call throws
# "Could not locate the bindings file" at runtime.
# Source: 2026-05-10 sector MCP binding regression — see plan
# Ansvar-Architecture-Documentation/docs/superpowers/plans/2026-05-10-sector-mcp-binding-regression-recovery.md
RUN npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src/ src/
# tsconfig include = ["src", "scripts"] with rootDir "."; scripts/ must be
# present for tsc to keep the dist/src/ prefix in build output (otherwise
# rootDir collapses to src/ and dist/http-server.js is emitted instead of
# dist/src/http-server.js, breaking the CMD path).
COPY scripts/ scripts/
RUN npm run build

# Drop devDependencies in place so the runtime stage can copy a lean
# node_modules tree that still contains the rebuilt better-sqlite3 binding.
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:26-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
ENV HCC_DB_PATH=/app/data/hcc.db

# Copy node_modules (with the rebuilt .node binding) from the builder.
# Do NOT run `npm ci` here — re-installing without rebuild would drop the
# binding and we'd ship a binding-less image again (root cause of 2026-05-09
# outage).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/
COPY package.json package-lock.json* ./

# Bake the pre-built database into the image so /app/data/hcc.db resolves
# at runtime without a bind mount.
#
# `data/database.db` is provisioned by ghcr-build.yml's "Provision database"
# step — it `gh release download`s `database.db.gz` and gunzips to that path.
# We then COPY it into the image at /app/data/hcc.db (HCC_DB_PATH). The
# explicit `data/<name>.db` reference is required for the workflow's grep
# `COPY\s+\K(data/\S+\.db)` to match.
COPY data/database.db data/hcc.db

# Non-root user for security
RUN addgroup -S -g 1001 mcp \
 && adduser -S -u 1001 -G mcp mcp \
 && chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
