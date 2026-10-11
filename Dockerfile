# Step 1: Build stage
FROM node:20-alpine AS builder

# youtube-dl-exec refuses to install without Python 3.9+; make/g++ cover a
# bcrypt node-gyp rebuild if no musl prebuilt is available; openssl is
# required at runtime by the Prisma query engine.
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Copy dependency files (+ .npmrc so fresh installs use the known-good
# peer resolution instead of failing on ERESOLVE)
COPY package*.json .npmrc ./
COPY prisma ./prisma/

# Install all dependencies including devDependencies for build
RUN npm install

# Copy source code
COPY . .

# Generate Prisma Client & compile TypeScript
RUN npx prisma generate
RUN npm run build

# Step 2: Production runtime stage
FROM node:20-alpine AS runner

# Same requirements as the builder stage, plus openssl for Prisma at runtime
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

ENV NODE_ENV=production

# Copy package files and prisma
COPY package*.json .npmrc ./
COPY prisma ./prisma/

# Install only production dependencies (prisma CLI is a regular dependency
# so `migrate deploy` runs at container start).
RUN npm install --omit=dev

# Copy built dist files & generated prisma client from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/public ./public

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/v1/health || exit 1

# Apply pending Prisma migrations (creates tables on first cloud deploy),
# then start the NestJS backend.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
