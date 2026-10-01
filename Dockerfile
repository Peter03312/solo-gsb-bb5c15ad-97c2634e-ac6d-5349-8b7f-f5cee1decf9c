# PhytoMeasure —— 植物显微切片测量 Web 应用
FROM node:20-bookworm-slim

# better-sqlite3 通常有预编译二进制；保留编译工具链以应对需要源码编译的平台
# fonts-wqy-zenhei 用于标注 PNG 中的中文（细胞名等）渲染
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ ca-certificates fonts-wqy-zenhei fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先安装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY server ./server
COPY public ./public

# 本地持久化目录：SQLite 数据库、原始图片、发布快照
RUN mkdir -p /app/data/images /app/data/snapshots
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

EXPOSE 8080

# 容器启动即自动完成目录与数据库表初始化（server/db.js）
CMD ["node", "server/index.js"]
