# Yazh Isai backend — single-context image.
# Build the frontend FIRST (npm run build in ../yzh) so its dist/ output
# lands in ./public, then: docker build -t yazh-isai .
# Debian-slim (glibc): yt-dlp binary + bcrypt prebuilds don't work on alpine.
FROM node:18-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

FROM node:18-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY public ./public
EXPOSE 5000
# Apply pending migrations, then serve API + frontend.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
