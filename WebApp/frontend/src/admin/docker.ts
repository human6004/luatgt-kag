/* Sinh bộ đóng gói Docker riêng (thay cho docker-compose-west.yml của OpenSPG).
   Không import gì để có thể chạy trực tiếp bằng `node --experimental-strip-types`. */

export interface DockerCfg {
  prefix: string;
  tag: string;
  registry: string;
  upstreamTag: string;
  tz: string;
  mysqlPassword: string;
  neo4jPassword: string;
  minioUser: string;
  minioPassword: string;
  serverHeapMin: number;
  serverHeapMax: number;
  neo4jHeapMax: number;
  neo4jPagecache: number;
  portServer: number;
  portNeo4jHttp: number;
  portNeo4jBolt: number;
  portMysql: number;
  portMinio: number;
  portMinioConsole: number;
  portApp: number;
  portWeb: number;
  includeApp: boolean;
  includeWeb: boolean;
  bundleDump: boolean;
  exposeDbPorts: boolean;
}

export const defaultDockerCfg: DockerCfg = {
  prefix: "kag-legal",
  tag: "1.0.0",
  registry: "",
  upstreamTag: "latest",
  tz: "Asia/Ho_Chi_Minh",
  mysqlPassword: "doi-mat-khau-mysql",
  neo4jPassword: "doi-mat-khau-neo4j",
  minioUser: "minio",
  minioPassword: "doi-mat-khau-minio",
  serverHeapMin: 2048,
  serverHeapMax: 8192,
  neo4jHeapMax: 4,
  neo4jPagecache: 1,
  portServer: 8887,
  portNeo4jHttp: 7474,
  portNeo4jBolt: 7687,
  portMysql: 3306,
  portMinio: 9000,
  portMinioConsole: 9001,
  portApp: 8000,
  portWeb: 8080,
  includeApp: true,
  includeWeb: true,
  bundleDump: true,
  exposeDbPorts: false,
};

const UPSTREAM = "spg-registry.us-west-1.cr.aliyuncs.com/spg";

export function serviceList(c: DockerCfg) {
  return [
    "mysql",
    "neo4j",
    "minio",
    "server",
    ...(c.includeApp ? ["app"] : []),
    ...(c.includeWeb ? ["web"] : []),
  ];
}

function env(c: DockerCfg) {
  return `# Sao chép thành .env rồi đổi mật khẩu trước khi chạy
COMPOSE_PROJECT_NAME=${c.prefix}
REGISTRY=${c.registry}
TAG=${c.tag}
UPSTREAM_TAG=${c.upstreamTag}
TZ=${c.tz}

MYSQL_PASSWORD=${c.mysqlPassword}
NEO4J_PASSWORD=${c.neo4jPassword}
MINIO_USER=${c.minioUser}
MINIO_PASSWORD=${c.minioPassword}

SERVER_XMS=${c.serverHeapMin}m
SERVER_XMX=${c.serverHeapMax}m
NEO4J_HEAP_MAX=${c.neo4jHeapMax}G
NEO4J_PAGECACHE=${c.neo4jPagecache}G

PORT_SERVER=${c.portServer}
PORT_NEO4J_HTTP=${c.portNeo4jHttp}
PORT_NEO4J_BOLT=${c.portNeo4jBolt}
PORT_MYSQL=${c.portMysql}
PORT_MINIO=${c.portMinio}
PORT_MINIO_CONSOLE=${c.portMinioConsole}
PORT_APP=${c.portApp}
PORT_WEB=${c.portWeb}

# Khoá mô hình — KHÔNG commit giá trị thật
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=
`;
}

function compose(c: DockerCfg) {
  const img = (s: string) => `\${REGISTRY}${c.prefix}-${s}:\${TAG}`;
  const db = (lines: string[]) =>
    c.exposeDbPorts
      ? lines
      : lines.map((l) => l.replace('- "', '- "127.0.0.1:'));
  const parts = [
    `name: ${c.prefix}

x-common: &common
  restart: unless-stopped
  environment: &tz
    TZ: \${TZ}
    LANG: C.UTF-8
  networks: [kag]

services:
  mysql:
    <<: *common
    build: { context: ./mysql, args: { UPSTREAM_TAG: \${UPSTREAM_TAG} } }
    image: ${img("mysql")}
    container_name: ${c.prefix}-mysql
    environment:
      <<: *tz
      MYSQL_ROOT_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_DATABASE: openspg
    command: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_general_ci"]
    volumes: [mysql-data:/var/lib/mysql]
    ports:
${db(['      - "${PORT_MYSQL}:3306"']).join("\n")}
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -p$$MYSQL_ROOT_PASSWORD --silent"]
      interval: 10s
      retries: 12

  neo4j:
    <<: *common
    build: { context: ./neo4j, args: { UPSTREAM_TAG: \${UPSTREAM_TAG} } }
    image: ${img("neo4j")}
    container_name: ${c.prefix}-neo4j
    environment:
      <<: *tz
      NEO4J_AUTH: neo4j/\${NEO4J_PASSWORD}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_server_memory_heap_initial__size: 1G
      NEO4J_server_memory_heap_max__size: \${NEO4J_HEAP_MAX}
      NEO4J_server_memory_pagecache_size: \${NEO4J_PAGECACHE}
      NEO4J_apoc_export_file_enabled: "true"
      NEO4J_apoc_import_file_enabled: "true"
      NEO4J_dbms_security_procedures_unrestricted: "*"
      NEO4J_dbms_security_procedures_allowlist: "*"
      RESTORE_DUMP: /dumps/legal.dump
    volumes:
      - neo4j-data:/data
      - neo4j-logs:/logs
      - ./dumps:/dumps:ro
    ports:
${db(['      - "${PORT_NEO4J_HTTP}:7474"', '      - "${PORT_NEO4J_BOLT}:7687"']).join("\n")}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:7474 >/dev/null || exit 1"]
      interval: 10s
      retries: 30
      start_period: 30s

  minio:
    <<: *common
    build: { context: ./minio, args: { UPSTREAM_TAG: \${UPSTREAM_TAG} } }
    image: ${img("minio")}
    container_name: ${c.prefix}-minio
    command: server --console-address ":9001" /data
    environment:
      <<: *tz
      MINIO_ROOT_USER: \${MINIO_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_PASSWORD}
    volumes: [minio-data:/data]
    ports:
${db(['      - "${PORT_MINIO}:9000"', '      - "${PORT_MINIO_CONSOLE}:9001"']).join("\n")}
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://127.0.0.1:9000/minio/health/live || exit 1"]
      interval: 10s
      retries: 12

  server:
    <<: *common
    build: { context: ./server, args: { UPSTREAM_TAG: \${UPSTREAM_TAG} } }
    image: ${img("server")}
    container_name: ${c.prefix}-server
    environment:
      <<: *tz
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
      NEO4J_PASSWORD: \${NEO4J_PASSWORD}
      SERVER_XMS: \${SERVER_XMS}
      SERVER_XMX: \${SERVER_XMX}
    depends_on:
      mysql: { condition: service_healthy }
      neo4j: { condition: service_healthy }
      minio: { condition: service_healthy }
    ports: ["\${PORT_SERVER}:8887"]
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://127.0.0.1:8887 >/dev/null || exit 1"]
      interval: 15s
      retries: 20
      start_period: 60s`,
  ];
  if (c.includeApp)
    parts.push(`
  app:
    <<: *common
    build: { context: ./app }
    image: ${img("app")}
    container_name: ${c.prefix}-app
    environment:
      <<: *tz
      KAG_HOST_ADDR: http://server:8887
      NEO4J_URI: neo4j://neo4j:7687
      NEO4J_PASSWORD: \${NEO4J_PASSWORD}
      OPENAI_BASE_URL: \${OPENAI_BASE_URL}
      OPENAI_API_KEY: \${OPENAI_API_KEY}
    volumes:
      - ./app/kag_config.yaml:/app/kag_config.yaml:ro
    depends_on:
      server: { condition: service_healthy }
    ports: ["\${PORT_APP}:8000"]`);
  if (c.includeWeb)
    parts.push(`
  web:
    <<: *common
    build: { context: .., dockerfile: deploy/web/Dockerfile }
    image: ${img("web")}
    container_name: ${c.prefix}-web
    ports: ["\${PORT_WEB}:80"]${c.includeApp ? "\n    depends_on: [app]" : ""}`);
  parts.push(`
volumes:
  mysql-data:
  neo4j-data:
  neo4j-logs:
  minio-data:

networks:
  kag:
    name: ${c.prefix}-net
`);
  return parts.join("\n");
}

const thin = (name: string, extra = "") => `ARG UPSTREAM_TAG=latest
FROM ${UPSTREAM}/openspg-${name}:\${UPSTREAM_TAG}
LABEL org.opencontainers.image.title="kag-legal-${name}" \\
      org.opencontainers.image.source="https://github.com/OpenSPG/openspg"
${extra}`;

const neo4jEntrypoint = `#!/bin/bash
# Lần chạy đầu: nếu có dump và database chưa có dữ liệu thì nạp dump, sau đó chạy neo4j bình thường.
set -e
if [ -f "$RESTORE_DUMP" ] && [ ! -f /data/.restored ]; then
  echo "[kag] Nạp đồ thị từ $RESTORE_DUMP ..."
  mkdir -p /tmp/dump && cp "$RESTORE_DUMP" /tmp/dump/neo4j.dump
  neo4j-admin database load neo4j --from-path=/tmp/dump --overwrite-destination=true
  touch /data/.restored
fi
exec /startup/docker-entrypoint.sh "$@"
`;

const serverStart = `#!/bin/sh
# Tham số lấy từ biến môi trường thay vì viết cứng trong compose.
G="neo4j://neo4j:7687?user=neo4j&password=\${NEO4J_PASSWORD}&database=neo4j"
exec java -Dfile.encoding=UTF-8 -Xms\${SERVER_XMS:-2048m} -Xmx\${SERVER_XMX:-8192m} \\
  -jar arks-sofaboot-0.0.1-SNAPSHOT-executable.jar \\
  --server.repository.impl.jdbc.host=mysql \\
  --server.repository.impl.jdbc.password=\${MYSQL_PASSWORD} \\
  --builder.model.execute.num=20 \\
  --cloudext.graphstore.url="$G" \\
  --cloudext.searchengine.url="$G"
`;

const appDockerfile = `FROM python:3.10-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*
# Mã nguồn trợ lý pháp luật (builder/, solver/, schema/ ...) đặt cạnh Dockerfile này
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8000
HEALTHCHECK CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;

const appRequirements = `openspg-kag
fastapi
uvicorn[standard]
`;

const webDockerfile = (
  c: DockerCfg,
) => `# Build giao diện React (Vite) rồi phục vụ bằng nginx
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80${c.includeApp ? "" : "\n# Không có service app: bỏ khối /api trong nginx.conf"}
`;

const nginx = (c: DockerCfg) => `server {
  listen 80;
  root /usr/share/nginx/html;
  location / { try_files $uri /index.html; }
${c.includeApp ? "  location /api/ { proxy_pass http://app:8000/; proxy_read_timeout 300s; }\n" : ""}}
`;

const buildSh = (c: DockerCfg) => `#!/usr/bin/env bash
# Build toàn bộ image của hệ thống từ deploy/
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp env.example .env
docker compose --env-file .env build --pull
docker compose --env-file .env images
echo "✓ Đã build: ${serviceList(c).join(", ")}"
`;

const packSh = (c: DockerCfg) => `#!/usr/bin/env bash
# Đóng gói image + compose + script cài đặt thành MỘT tệp để chia sẻ (không cần mạng ở máy nhận)
set -euo pipefail
cd "$(dirname "$0")"
source .env
OUT=../dist/${c.prefix}-bundle-$TAG
rm -rf "$OUT" && mkdir -p "$OUT/images"
IMAGES=$(docker compose --env-file .env config --images)
echo "→ docker save: $IMAGES"
docker save $IMAGES | gzip -1 > "$OUT/images/${c.prefix}-$TAG.tar.gz"
cp docker-compose.yml env.example install.sh install.ps1 "$OUT/"
mkdir -p "$OUT/dumps"${c.includeApp ? '\nmkdir -p "$OUT/app" && cp app/kag_config.yaml "$OUT/app/" 2>/dev/null || true' : ""}
${c.bundleDump ? 'cp dumps/*.dump "$OUT/dumps/" 2>/dev/null || echo "(không có dump — bỏ qua)"' : "# bundleDump=false: không kèm dữ liệu đồ thị"}
# Máy nhận không build lại: bỏ các khối build: khỏi compose
sed -i.bak '/^    build:/d' "$OUT/docker-compose.yml" && rm "$OUT/docker-compose.yml.bak"
(cd "$OUT" && sha256sum images/* dumps/* 2>/dev/null > SHA256SUMS || true)
tar -C ../dist -czf "$OUT.tar.gz" "$(basename "$OUT")"
echo "✓ Gói chia sẻ: $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1))"
`;

const installSh = (c: DockerCfg) => `#!/usr/bin/env bash
# Chạy trên máy bạn bè: giải nén gói rồi ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Cần cài Docker trước"; exit 1; }
[ -f SHA256SUMS ] && sha256sum -c SHA256SUMS
echo "→ Nạp image (không cần tải từ internet)"
for f in images/*.tar.gz; do gunzip -c "$f" | docker load; done
[ -f .env ] || { cp env.example .env; echo "⚠ Đã tạo .env — hãy đổi mật khẩu/API key rồi chạy lại nếu cần"; }
docker compose --env-file .env up -d
echo "→ Chờ các dịch vụ healthy..."
for i in $(seq 1 60); do
  BAD=$(docker compose ps --format '{{.Health}}' | grep -vc healthy || true)
  [ "$BAD" = "0" ] && break; sleep 5
done
docker compose ps
echo "✓ OpenSPG: http://localhost:${c.portServer}${c.includeWeb ? `  ·  Web: http://localhost:${c.portWeb}` : ""}"
`;

const installPs1 = (
  c: DockerCfg,
) => `# Windows: chuột phải > Run with PowerShell
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Get-ChildItem images\\*.tar.gz | ForEach-Object { docker load -i $_.FullName }
if (-not (Test-Path .env)) { Copy-Item env.example .env; Write-Warning "Đã tạo .env — hãy đổi mật khẩu/API key" }
docker compose --env-file .env up -d
docker compose ps
Write-Host "OpenSPG: http://localhost:${c.portServer}${c.includeWeb ? `  Web: http://localhost:${c.portWeb}` : ""}"
`;

const readme = (c: DockerCfg) => `# Docker riêng cho ${c.prefix}

Thay thế \`docker-compose-west.yml\` của OpenSPG. Image gốc chỉ dùng làm lớp nền khi build; sau đó mọi thứ
được gắn tên \`${c.prefix}-*:${c.tag}\` và đóng thành **một tệp** để chia sẻ.

| Bước | Lệnh |
|---|---|
| 1. Cấu hình | \`cp env.example .env\` rồi đổi mật khẩu |
| 2. Build | \`./build.sh\` |
| 3. Chạy thử | \`docker compose up -d\` |
| 4. Đóng gói | \`./pack.sh\` → \`dist/${c.prefix}-bundle-${c.tag}.tar.gz\` |
| 5. Máy bạn bè | giải nén → \`./install.sh\` (hoặc \`install.ps1\` trên Windows) |

Khác biệt so với compose gốc:
- mật khẩu, cổng, bộ nhớ đọc từ \`.env\` (không viết cứng);
- volume có tên (dữ liệu không mất khi xoá container);
- healthcheck + \`depends_on: service_healthy\` (server chờ DB sẵn sàng);
- neo4j tự nạp \`dumps/legal.dump\` ở lần chạy đầu;
- ${c.exposeDbPorts ? "cổng DB mở ra mạng" : "cổng MySQL/Neo4j/MinIO chỉ bind 127.0.0.1"};
- múi giờ ${c.tz}.

Lưu ý: image OpenSPG theo giấy phép Apache-2.0 — giữ LICENSE khi phân phối lại.
`;

export function generateFiles(c: DockerCfg): Record<string, string> {
  const f: Record<string, string> = {
    "deploy/README.md": readme(c),
    "deploy/docker-compose.yml": compose(c),
    "deploy/env.example": env(c),
    "deploy/mysql/Dockerfile": thin("mysql"),
    "deploy/minio/Dockerfile": thin("minio"),
    "deploy/neo4j/Dockerfile": thin(
      "neo4j",
      'COPY restore-entrypoint.sh /restore-entrypoint.sh\nRUN chmod +x /restore-entrypoint.sh\nENTRYPOINT ["/restore-entrypoint.sh"]\nCMD ["neo4j"]\n',
    ),
    "deploy/neo4j/restore-entrypoint.sh": neo4jEntrypoint,
    "deploy/server/Dockerfile": thin(
      "server",
      'COPY start.sh /start.sh\nUSER root\nRUN chmod +x /start.sh\nCMD ["/start.sh"]\n',
    ),
    "deploy/server/start.sh": serverStart,
    "deploy/dumps/.gitkeep": "",
    "deploy/build.sh": buildSh(c),
    "deploy/pack.sh": packSh(c),
    "deploy/install.sh": installSh(c),
    "deploy/install.ps1": installPs1(c),
  };
  if (c.includeApp) {
    f["deploy/app/Dockerfile"] = appDockerfile;
    f["deploy/app/requirements.txt"] = appRequirements;
  }
  if (c.includeWeb) {
    f["deploy/web/Dockerfile"] = webDockerfile(c);
    f["deploy/web/nginx.conf"] = nginx(c);
  }
  return f;
}
