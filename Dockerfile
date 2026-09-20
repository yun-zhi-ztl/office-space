# 卫生间坑位预约系统 - 后端容器镜像
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

# 数据都保存在进程内存里，重启即重置，适合本地演示
CMD ["node", "server.js"]