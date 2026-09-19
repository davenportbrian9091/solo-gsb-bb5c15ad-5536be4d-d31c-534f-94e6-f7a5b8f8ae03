# syntax=docker/dockerfile:1
# 单阶段镜像：安装依赖 -> 构建前后端 -> 精简依赖 -> 运行
FROM node:20-alpine

WORKDIR /app

# 先复制 workspace 清单以利用层缓存
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY . .

# 安装（含 devDependencies 供构建）-> 构建 -> 仅重装生产依赖
RUN npm install --no-audit --no-fund \
  && npm run build \
  && rm -rf node_modules \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/dist/index.js"]
