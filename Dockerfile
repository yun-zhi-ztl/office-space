# OfficeSpace 办公空间管理 - 后端容器镜像
FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存加速重建
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 拷贝应用代码与静态前端
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]