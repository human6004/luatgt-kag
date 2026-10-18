# Vận hành Docker LuậtGT

[INSTALL](../docs/INSTALL.md) là hướng dẫn cài duy nhất; [UPDATE](../docs/UPDATE.md) hướng dẫn nâng phiên bản. Lệnh dưới đây chạy từ root repository, dùng `.env` chung.

## Cấu trúc

`docker-compose.yml` tự include `docker-compose.kag.yml` trong **một project `luatgt`**. Compose từ 2.20.3; không ghép hai file bằng `-f` hay chạy fragment KAG riêng.

- WebApp: `mysql`, `redis`, `minio`, `backend`, `frontend`.
- OpenSPG: `openspg-mysql`, `openspg-neo4j`, `openspg-minio`, `openspg-server`.
- KAG: `kag-api`, `kag-builder`, `kag-ingress`.

Tổng 12 services. API/Builder/OpenSPG Server dùng cùng image KAG; runtime và dependencies build trong containers. Pins: [runtime](../docs/runtime.md), Dockerfiles và Compose.

## Vận hành

**Bước 1 — Xem lỗi:**

```powershell
docker compose ps -a
docker compose logs --tail 100 backend frontend kag-api kag-builder
```

Kết quả chỉ ra service chưa chạy/lỗi. Chọn service liên quan để xem log; che secrets trước khi chia sẻ. `/v1/health` chỉ kiểm API còn phản hồi; ADMIN đọc readiness ở Hạ tầng.

**Bước 2 — Dừng:** nếu Builder đang ghi, chọn Stop và đợi dừng sạch trước; trạng thái chưa rõ xử lý theo [runner](../docs/runner.md#resume-trạng-thái-và-lock).

```powershell
docker compose stop -t 120
```

Kết quả: containers dừng, volumes/state giữ nguyên. Builder dùng namespace mạng OpenSPG; dừng Builder trước khi recreate OpenSPG. Không dùng `down -v`, prune hoặc xóa khóa.

**Bước 3 — Chạy lại:**

```powershell
docker compose start
```

Lệnh bật lại containers hiện có. Đổi source/cấu hình dùng UPDATE.

## Cổng và mạng

Cổng publish mặc định chỉ ở `127.0.0.1`: WebApp 8081 (`WEBAPP_PORT`), backend 8080 (`BACKEND_PORT`), MySQL 3306 (`MYSQL_PORT`), Redis 6379 (`REDIS_PORT`), MinIO 9000/9001 (`MINIO_PORT`/`MINIO_CONSOLE_PORT`). Backend API có tiền tố `/api`.

Quản trị OpenSPG/Neo4j đi qua HAProxy `kag-ingress`, chỉ publish `127.0.0.1:8887`, `127.0.0.1:7474` và `127.0.0.1:7687`. Proxy chuyển TCP tới đúng service/port, gồm WebSocket của Neo4j Browser; không thêm đường outbound cho storage. Containers chỉ nối mạng `internal` không publish host port trực tiếp được trên Docker đang dùng.

KAG API, Worker 8010, broker 8899 và gateway provider 8898 không publish ra host. Backend gọi `kag-api:8000`, control `openspg-server:8010`. Builder chung namespace mạng OpenSPG Server; Java OpenSPG nghe `0.0.0.0:8887` trong mạng container. Dùng DNS service, không dùng IP/container ID động.

Mạng `private` chứa storage OpenSPG; `readbus` nối API/backend/broker; cả hai internal. `kag-ingress` nối hai mạng này với `ingress` để chuyển tiếp cổng quản trị và kiểm soát provider. API/Worker/OpenSPG/Neo4j vẫn chỉ nối mạng internal. Backend không có Docker Socket hoặc mật khẩu graph.

## Truy cập quản trị OpenSPG và Neo4j

- **OpenSPG:** [http://127.0.0.1:8887/](http://127.0.0.1:8887/), dùng tài khoản OpenSPG riêng. Tài khoản được lưu trong catalog OpenSPG MySQL, không phải `ADMIN_EMAIL`/`ADMIN_PASSWORD` của WebApp hay mật khẩu MySQL. Installation còn tài khoản seed xem mục Product mode trong [README upstream đã pin](../vendor/KAG/README.md); không chép mật khẩu vào URL, log hoặc tài liệu. Nếu xuất hiện **Reset Password**, chủ tài khoản phải tự đặt **New Password** và **Confirm Password** trước khi vào quản trị; không bỏ kiểm tra này hoặc reset bằng SQL.
- **Neo4j Browser:** [mở kết nối trực tiếp localhost](http://127.0.0.1:7474/browser/?connectURL=bolt%3A%2F%2F127.0.0.1%3A7687&db=neo4j). Trong **Connect to Neo4j**, chọn `bolt://`, địa chỉ `127.0.0.1:7687`, nhập database cần xem và user `neo4j`. Lấy mật khẩu đã cấu hình từ `KAG_NEO4J_PASSWORD` trong `.env` của installation; đổi `.env` không đổi mật khẩu database đã có.

Neo4j image pin hiện chứa Kernel 5.25.1/DozerDB. HTTP và Bolt nghe `0.0.0.0` trong container; địa chỉ advertised mặc định vẫn là `localhost:7474`/`localhost:7687`. Link Browser trên chỉ định `bolt://127.0.0.1:7687` để kết nối trực tiếp qua proxy; ứng dụng trong Docker vẫn dùng `openspg-neo4j`, không dùng localhost của máy người dùng. Cả đường Bolt trực tiếp và `neo4j://openspg-neo4j:7687` nội bộ phải hoạt động sau cập nhật.

Trong Browser, chạy `SHOW DATABASES;`, rồi `:use <database>` trước khi xem. Dùng `MATCH (n) RETURN n LIMIT 25;` hoặc `MATCH (a)-[r]->(b) RETURN a,r,b LIMIT 25;` để xem graph. Database rỗng trả 0 kết quả; không tự nạp graph ví dụ của Browser. Project OpenSPG và database Neo4j là hai định danh khác nhau. [Hướng dẫn Builder](../docs/runner.md#chọn-project-và-nạp-schema) chỉ cách tạo Knowledge Base, chọn ID trên LuậtGT rồi **Xem thay đổi → Chuẩn bị cấu trúc LuậtGT**; không cần terminal hoặc sửa biến target cho mỗi project. Đăng nhập OpenSPG bằng cùng hostname với LuậtGT; ADMIN LuậtGT không thay quyền sở hữu project PRIVATE. Nút **Mở Neo4j** ở kết quả Builder dùng database của run đã xác minh.

Giữ ba cổng ở localhost. Không đổi mạng storage thành external, publish 8010/8899/8898 hoặc tắt xác thực để sửa lỗi truy cập. Khi đổi ports hoặc proxy config, cập nhật đúng service `kag-ingress`; khi đổi listener Java, dừng Builder sạch rồi recreate `openspg-server` và `kag-builder` cùng namespace theo [UPDATE](../docs/UPDATE.md).

## Provider cho OpenSPG

UI tạo Knowledge Base chỉ cần model **Embedding**. Thêm model tại tên tài khoản góc phải → **Model Configuration → OpenAI → Add Model**, chọn `embedding`, **Private**, nhập base URL, API key và model ID của provider. [Hướng dẫn điền từng trường](../docs/runner.md#thêm-embedding-cho-openspg). Catalog OpenSPG độc lập với secret store LuậtGT; key không tự đồng bộ.

Đường Embedding native dùng bridge của sản phẩm và transport/policy API/Builder hiện có. OpenSPG chỉ nhận token egress ở mount chỉ đọc, không nhận key model của LuậtGT. Gateway 8898 vẫn nội bộ; yêu cầu đúng token, endpoint và nguồn gọi. Không gỡ kiểm endpoint hoặc thêm mạng Internet cho OpenSPG.

- `.env`: `KAG_PROVIDER_ENABLED=1` cho phép provider qua gateway; mặc định `0` thì phép kiểm model bị chặn. Không đổi token đang dùng; giữ `${KAG_STATE_DIR}/egress.token`.
- Public provider: base URL HTTPS cổng 443; hostname phải nằm trong `docker/kag-ingress/provider-hosts.lst` hoặc file do `KAG_PROVIDER_HOSTS_FILE` chỉ định. Gateway kiểm DNS/IP public và chứng thư TLS. Thêm chính xác hostname đã duyệt, không dùng wildcard.
- Proxy tùy chọn: `KAG_PROVIDER_PROXY_BASE_URL` phải khớp chính xác base URL người dùng nhập; gateway chuyển tới `KAG_CHAT_PROXY_HOST:KAG_CHAT_PROXY_PORT`. Chỉ bật `KAG_CHAT_PROXY_TEST_SAFE=1` sau khi xác minh retry/rotation/fallback đã tắt, hoặc chủ động chấp nhận chúng bằng `KAG_CHAT_PROXY_ALLOW_UPSTREAM_RETRIES=1`. Không bật cờ để ép kiểm đạt.
- Sau khi đổi policy/allowlist, cập nhật đồng bộ `kag-api`, `openspg-server`, `kag-builder`, `kag-ingress` theo [UPDATE](../docs/UPDATE.md); dừng Builder sạch trước khi recreate namespace OpenSPG. Source/image/policy nằm trong repo, không cần helper hoặc artifacts phát triển.

**OK** khi thêm Embedding và **Save** khi tạo Knowledge Base đều gọi model thật với `input: "hello"`; có thể tính phí. SDK không tự retry hoặc theo redirect, nhưng Java OpenSPG và proxy có retry riêng. Kiểm DNS/TCP/TLS hoặc mở được UI không chứng minh key/model hợp lệ. Khi lỗi chung **OpenSPG Embedding check failed**, đối chiếu endpoint/model/key và policy; không chia sẻ raw config/log chứa secrets. Chat native OpenSPG chưa được nối trong tích hợp Embedding này; Chat LuậtGT giữ cấu hình riêng.

## Storage và secrets

Mặc định có **11 named volumes**: 3 WebApp (MySQL/Redis/MinIO), 4 OpenSPG (MySQL/Neo4j data/logs/MinIO), 4 KAG (runs/locks/provider state/Builder state). Không trỏ stack thử tới storage đang phục vụ.

Giữ các biến mapping khi cập nhật:

- `COMPOSE_PROJECT_NAME`, `WEBAPP_STORAGE_PROJECT`, `KAG_STORAGE_PROJECT`: namespace tên volume.
- `WEBAPP_STORAGE_EXTERNAL`, `KAG_STORAGE_EXTERNAL`: `true` yêu cầu volumes hiện hữu.
- `KAG_NEO4J_STORAGE_REVISION`: hậu tố volume Neo4j data.
- `KAG_GRAPH_LOCK_VOLUME`: volume khóa chung cho mọi writer cùng physical database, không đổi để né khóa.

`.env.example` đặt `KAG_STATE_DIR=./.secrets`: state nằm trong repo local, được loại khỏi Git và Docker build context. Giữ bốn token và các thư mục `release`, `api-credentials`, `broker-credentials`, `builder-input`. Cài đặt cũ vẫn dùng đường dẫn trong `.env`; khi không đặt biến này, Compose dùng `../luatgt-state` để giữ tương thích. Runs/locks/provider counters nằm trong named volumes. Windows dùng dấu `/` trong đường dẫn `.env`.

Biến shell có thể ghi đè `.env`; `.env` không tự truyền tất cả biến vào containers. Bảo vệ quyền đọc secrets/config/backup. Linux cần file cho UID 10001 đọc; Compose `uid/gid/mode` không thay quyền file nguồn bind mount.

## Sao lưu

### Bước 1 — Dừng mọi nơi ghi dữ liệu

Thông báo bảo trì, ngừng chat/sửa nội dung; dừng Builder sạch rồi dừng stack theo [vận hành](#vận-hành). Kiểm:

```powershell
docker compose ps --status running -q
```

Kết quả phải rỗng. Nếu service chưa dừng hoặc bị buộc dừng lúc ghi, xử lý trước khi sao lưu. Volume dùng chung với installation khác cũng cần ngừng nơi ghi đó.

### Bước 2 — Ghi mapping và sao chép file host

Đọc tên volume thực tế và vị trí mount, không dựa riêng vào tiền tố `luatgt`:

```powershell
$containers = @(docker compose ps -aq)
if ($LASTEXITCODE -ne 0 -or $containers.Count -ne 12) { throw 'Cần xác định đủ containers của installation trước khi sao lưu.' }
docker inspect --format '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Name}} -> {{.Destination}}; {{end}}' $containers
```

Kết quả là mapping theo containers hiện có. Với bind mounts, xem **Inspect → Mounts → Source** của container trong Docker Desktop để xác định thư mục host.

Tạo thư mục backup mới **ngoài repo**, đủ dung lượng. Dùng File Explorer sao chép `.env`, hai Compose files, toàn bộ `KAG_STATE_DIR` và mọi bind source tùy chỉnh. Lưu mapping vừa đọc cùng phiên bản source (`git rev-parse HEAD`) và images đang dùng. Không lưu output đầy đủ `compose config` chứa secrets.

### Bước 3 — Export từng volume

Đăng nhập Docker Desktop → **Volumes** → chọn từng tên trong mapping → **Exports → Quick export → Local file** → lưu vào thư mục backup. Làm đủ mọi named volume, gồm cả runs/locks/provider state. Đây là [chức năng export của Docker Desktop](https://docs.docker.com/desktop/use-desktop/volumes/#export-a-volume-now); không cần script sao lưu riêng.

Kết quả: mỗi volume có file export, cùng cấu hình/state/mapping. Chờ tất cả export hoàn tất, kiểm số file và trạng thái thành công trước UPDATE. Giữ quyền đọc backup hạn chế và một bản ở nơi lưu trữ an toàn khác.

Export thành công chưa chứng minh phục hồi được. Thử import trên **volume riêng** trước khi cần phục hồi; import vào volume có dữ liệu sẽ ghi đè. Không restore đè storage đang phục vụ; cần đúng source/image/schema của bản sao.

## Cấu hình chatbot

Dành cho người vận hành đã chuẩn bị graph và nguồn, không phải bước bắt buộc để mở WebApp:

- **Nguồn:** `KAG_RELEASE_ID`, `KAG_WEBAPP_SNAPSHOT_ID` khớp bộ tệp trong `state/release`; xuất bản WebApp không tự đồng bộ graph.
- **Broker mặc định khi cấu hình serving:** `KAG_BROKER_URL=http://openspg-server:8899`; API cần `api-credentials/broker.token`, `sample-proof.sha256`; broker cần `broker-credentials/neo4j.password`, `broker.token` và `KAG_BROKER_DATABASE_ID`/`KAG_BROKER_SERVER_ID` đã được xác minh. Xem [backend identity](../docs/backend-identity.md).
- **Reader thay thế:** `KAG_READER_USERNAME`, `api-credentials/reader.password`, `KAG_SAMPLE_PROOF_SHA256`, endpoint chỉ đọc và mạng tới graph. Topology mặc định không nối API vào storage. Không bật reader cùng broker.
- **Mô hình:** `KAG_EMBEDDING_URL`, `KAG_EMBEDDING_MODEL`, `KAG_CHAT_URL`, `KAG_CHAT_MODEL`; keys ở `api-credentials/embedding.key`, `chat.key`. Embedding khớp model graph, 3072 chiều.
- **Ngân sách query:** `KAG_QUERY_PROFILE=1`, `api-credentials/query-proof.sha256`, gateway và bộ đếm provider. Bật biến không tự cấp quyền provider.
- **Gateway:** `KAG_PROVIDER_ENABLED`, `KAG_CHAT_PROXY_HOST`, `KAG_CHAT_PROXY_PORT`; mặc định tắt. Host/cổng mặc định là `host.docker.internal:8317`; operator phải cung cấp proxy, repo không tự chạy nó.
- **Dataset đánh giá:** `KAG_EVALUATION_ENABLED=1`, dữ liệu đã chuẩn bị trong `release/evaluation`.

Không sửa hash/identity để ép READY. Thiếu graph/provider/nguồn phù hợp thì query chưa khả dụng; healthcheck không thay readiness. Luồng và hợp đồng: [kiến trúc](../docs/architecture.md).

## Builder

Worker chờ yêu cầu ADMIN; không tự chạy lúc startup. Trang **Dựng đồ thị** chuẩn bị corpus, lưu cấu hình, kiểm sẵn sàng và điều khiển Build/Stop/Resume. Đích graph lấy từ các biến deployment `KAG_BUILDER_*`; model/key từ Embedding đã lưu và kiểm tra trong Admin → Cấu hình, không cần Apply Chat.

Corpus/schema được đóng gói trong image. **Kiểm tra và chuẩn bị** dùng volume `kag-builder-state` tại `/builder-state` (`KAG_BUILDER_STATE_DIR`), tách khỏi run history và source checkout. Giữ volume này khi cập nhật/backup; không mount workspace phát triển vào sản phẩm.

Config sản phẩm lưu tại `/builder-state/configuration.json`; mỗi revision giữ run root riêng dưới `/builder-runs`, khóa tại `/run/kag-locks`. `builder-input/runner.json` chỉ dành cho cấu hình Runner thủ công cũ khi chưa lưu cấu hình sản phẩm. Giữ cả Builder state, runs, locks và provider state khi backup/update. Sau restart, kiểm lại nguồn/sẵn sàng trước Resume; kết quả đã xác minh vẫn xem được khi cấu hình hiện tại thiếu hoặc đã đổi.

Mặc định thiếu đích/model nên Build bị chặn. Xóa dữ liệu chỉ được cấp theo đúng project và physical database qua `KAG_BUILDER_CLEAR_TARGETS` (mặc định `[]` từ chối), vẫn chặn đích dùng chung/serving. Full Build cần đích riêng với listener/DNS, physical identity, schema và bốn vector indexes phù hợp. Không dùng graph serving làm đích Build hoặc mở listener để vượt kiểm tra. Chọn phạm vi, dừng/tiếp tục, bỏ phiên và xóa để dựng lại: [runner](../docs/runner.md). Dựng xong không tự chuyển Chat sang graph mới.
