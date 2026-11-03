# PayPali app image. Runs the persistent server (scripts/start.mjs), which bundles
# src/server/paypaliServer.ts with esbuild at boot and serves on $PORT (default 4000).
#
#   docker build -t paypali .
#   docker run --rm -p 4000:4000 \
#     -e PAYPALI_DATABASE_URL=postgres://paypali:paypali@host.docker.internal:5432/paypali \
#     -e PAYPALI_PUBLIC_URL=https://mcp.example.com paypali
#
# Point PAYPALI_DATABASE_URL at a real Postgres for a shared, multi-instance
# deployment. Secrets can be passed as files via <NAME>_FILE (see src/server/secrets.ts),
# e.g. a Docker/K8s secret mounted at /run/secrets/paypal_client_secret with
# PAYPAL_CLIENT_SECRET_FILE=/run/secrets/paypal_client_secret.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install all dependencies (esbuild + prisma are needed at boot to bundle and to
# generate the client). npm ci needs the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# App source.
COPY . .

# Generate the Prisma client and the full-schema SQL the DB bootstrap applies to a
# fresh database. Neither step connects to a database; the URL is a build-time stub.
ENV DATABASE_URL=postgresql://paypali:paypali@localhost:5432/paypali?schema=public
RUN npm run prisma:generate && npm run schema:sql

# Run as the unprivileged user the node image ships with. .data (on-disk PGlite +
# generated secrets) is only used when PAYPALI_DATABASE_URL is unset.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node

ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/.well-known/agent.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start.mjs"]
