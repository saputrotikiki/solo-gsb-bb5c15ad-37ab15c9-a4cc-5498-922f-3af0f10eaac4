# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# 编译并产出静态文件到 /app/dist
COPY . .
RUN npm run build

# ---- 运行阶段：Nginx 托管静态资源 ----
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
