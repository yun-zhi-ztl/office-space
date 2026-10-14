# OfficeSpace 办公空间管理 - 后端容器镜像
FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存加速重建
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 拷贝应用代码与静态前端
COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# 利用 /api/health 探活（Node 20 自带 fetch）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]