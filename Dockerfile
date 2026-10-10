# Yazh Isai backend — single-context image.
# Build the frontend FIRST (npm run build in ../yzh) so its dist/ output
# lands in ./public, then: docker build -t yazh-isai .
# Debian-slim (glibc): yt-dlp binary + bcrypt prebuilds don't work on alpine.
FROM node:18-slim AS builder
WORKDIR /app
# youtube-dl-exec's install script requires Python 3.9+ (the yt-dlp
# binary itself is standalone, but the gate fails the build without it).
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
# Placeholder so `prisma generate` can validate the schema at build time.
# Real DATABASE_URL comes from the platform environment at runtime.
ENV DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
RUN npx prisma generate
RUN npm run build

FROM node:18-slim
WORKDIR /app
ENV NODE_ENV=production
# Prisma's engine needs OpenSSL for TLS connections to managed Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY public ./public
EXPOSE 5000
# Apply pending migrations, then serve API + frontend.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
