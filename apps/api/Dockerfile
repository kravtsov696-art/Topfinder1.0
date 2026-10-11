# Сборка только API (мобильные зависимости не ставятся).
# Контекст сборки — корень репозитория: docker build -f apps/api/Dockerfile .
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY apps/api/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY packages/shared /app/packages/shared
COPY apps/api/src ./src
COPY apps/api/migrations ./migrations
COPY apps/api/test/smoke.ts ./test/smoke.ts
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
