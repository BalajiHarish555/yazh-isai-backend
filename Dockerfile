# Step 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY package*.json ./
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

WORKDIR /app

ENV NODE_ENV=production

# Copy package files and prisma
COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies, plus the Prisma CLI (devDependency
# upstream) so `migrate deploy` runs at container start.
RUN npm install --only=production
RUN npm install --no-save prisma@5.22.0

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
