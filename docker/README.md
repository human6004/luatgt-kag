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

**Bước 2 — Dừng:** nếu Builder đang chạy, bấm **Dừng an toàn** và chờ **Đã dừng an toàn** trước. Kết quả chưa rõ thì giữ khóa và xử lý theo [runner](../docs/runner.md#resume-trạng-thái-và-lock).

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

- **OpenSPG:** [http://127.0.0.1:8887/](http://127.0.0.1:8887/), dùng tài khoản OpenSPG do người vận hành cấp. Tài khoản nằm trong catalog OpenSPG MySQL, độc lập với WebApp và mật khẩu MySQL. Installation mới còn tài khoản seed xem mục **4.1.2 Use the product** trong [README upstream đã pin](../vendor/KAG/README.md#412-use-the-product). Nếu xuất hiện **Reset Password**, chủ tài khoản tự hoàn tất **New Password** và **Confirm Password**; không reset bằng SQL hoặc ghi mật khẩu vào URL/log.
- **Neo4j Browser:** [mở kết nối trực tiếp localhost](http://127.0.0.1:7474/browser/?connectURL=bolt%3A%2F%2F127.0.0.1%3A7687&db=neo4j). Trong **Connect to Neo4j**, chọn `bolt://`, địa chỉ `127.0.0.1:7687`, nhập database cần xem và user `neo4j`. Lấy mật khẩu đã cấu hình từ `KAG_NEO4J_PASSWORD` trong `.env` của installation; đổi `.env` không đổi mật khẩu database đã có.

Browser dùng `bolt://127.0.0.1:7687` trực tiếp qua proxy. Ứng dụng trong Docker dùng `neo4j://openspg-neo4j:7687`, không dùng localhost của host. Listener HTTP/Bolt phải nhận kết nối trong mạng container; không mở thêm cổng hoặc đổi routing khi chưa xác định nguyên nhân lỗi.

Link Browser mặc định mở database `neo4j`, không tự chọn graph Builder. Dùng **Mở Neo4j** từ kết quả Builder để chọn đúng database; hoặc chạy `SHOW DATABASES;` rồi `:use <database-của-bạn>`. [Kết quả Builder](../docs/runner.md#5-kết-quả) có truy vấn mẫu giới hạn 25 kết quả. Không tự nạp graph ví dụ của Browser.

Tạo Knowledge Base và chuẩn bị cấu trúc theo [runner](../docs/runner.md#tạo-project-trong-openspg). Dùng cùng hostname cho OpenSPG/LuậtGT; ADMIN LuậtGT không thay quyền sở hữu project Private. Project và database là hai định danh khác nhau.

Giữ ba cổng ở localhost. Không đổi mạng storage thành external, publish 8010/8899/8898 hoặc tắt xác thực để sửa lỗi truy cập. Khi đổi ports hoặc proxy config, cập nhật đúng service `kag-ingress`; khi đổi listener Java, dừng Builder sạch rồi recreate `openspg-server` và `kag-builder` cùng namespace theo [UPDATE](../docs/UPDATE.md).

## Provider cho OpenSPG

UI tạo Knowledge Base chỉ cần **Embedding**. [Runner](../docs/runner.md#thêm-embedding-cho-openspg) giữ hướng dẫn điền từng trường; [USER-GUIDE](../docs/USER-GUIDE.md#cấu-hình-model) hướng dẫn model LuậtGT. Hai kho cấu hình độc lập, key không tự đồng bộ.

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

Ba token lưu/kiểm/áp dụng model lấy từ các biến `KAG_*_SECRET_FILE` riêng theo [INSTALL](../docs/INSTALL.md#3-tạo-cấu-hình-và-secrets). Key lưu qua UI ở file riêng quyền `0600` trong provider state; không trả key qua API và không mã hóa tại chỗ. Bảo vệ cả volume và mọi bản sao.

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
git rev-parse HEAD
docker compose images
```

Kết quả là mapping theo containers hiện có. Với bind mounts, xem **Inspect → Mounts → Source** của container trong Docker Desktop để xác định thư mục host.

Tạo thư mục backup mới **ngoài repo**, đủ dung lượng. Dùng File Explorer sao chép `.env`, hai Compose files, toàn bộ `KAG_STATE_DIR` và mọi bind source tùy chỉnh. Lưu mapping vừa đọc cùng phiên bản source (`git rev-parse HEAD`) và images đang dùng. Không lưu output đầy đủ `compose config` chứa secrets.

### Bước 3 — Export từng volume

Đăng nhập Docker Desktop → **Volumes** → chọn từng tên trong mapping → **Exports → Quick export → Local or Hub storage → Local file** → chọn nơi lưu → **Save**. Làm đủ mọi named volume, gồm Builder state/runs/locks và provider state. Đây là [chức năng export của Docker Desktop](https://docs.docker.com/desktop/use-desktop/volumes/#export-a-volume-now). Không đưa backup chứa secrets lên Hub/cloud.

Kết quả: mỗi volume có file export, cùng cấu hình/state/mapping. Chờ tất cả export hoàn tất, kiểm số file và trạng thái thành công trước UPDATE. Giữ quyền đọc backup hạn chế và một bản ở nơi lưu trữ an toàn khác.

Export thành công chưa chứng minh phục hồi được. Thử import trên **volume riêng** trước khi cần phục hồi; import vào volume có dữ liệu sẽ ghi đè. Không restore đè storage đang phục vụ; cần đúng source/image/schema của bản sao.

Trong Docker Desktop, tạo/chọn volume thử → **Import → Local file**, chọn bản export và xác nhận. Kiểm dữ liệu/tài khoản/lịch sử trên môi trường phục hồi riêng trước khi chuyển đổi. Hạ image không đảo ngược migration database; giữ images cũ cùng backup đến khi kiểm xong bản cập nhật.

## Cấu hình chatbot

Dành cho người vận hành đã chuẩn bị graph và nguồn, không phải bước bắt buộc để mở WebApp:

Chat và Embedding dùng kết nối được lưu/kiểm/áp dụng riêng tại **Cài đặt hệ thống → Kết nối model**. Phạm vi hiện hỗ trợ OpenAI-compatible: POST `<Base URL>/chat/completions` cho nội dung chữ và POST `<Base URL>/embeddings` cho vector. Base URL có thể mang prefix như `/v1`; không nhận query, fragment hay credentials trong URL. Public HTTPS phải nằm trong danh sách host cho phép; proxy HTTP riêng phải đăng ký đúng Base URL theo [chính sách provider](#provider-cho-openspg). Không cần EvelProxy, binary đã vá hoặc chức năng chuyển tài khoản của một proxy cụ thể.

Với graph Builder đã xác minh, dùng [luồng trên UI](../docs/runner.md#chọn-graph-phục-vụ-truy-xuấtchat): lưu/kiểm model, mở **Đồ thị của tôi**, chọn project/phiên, thử truy xuất nếu muốn và **Dùng cho Chat**. Nhánh dataset đóng gói snapshot nguồn đã đọc/đối chiếu cùng graph, không cần publication MySQL. Lựa chọn lưu trong provider state; release bất biến nằm trong Builder state, API chỉ mount đọc. Worker giữ credentials Neo4j và chỉ cấp phép đọc cố định qua mạng private. Không cần chép graph, sửa `.env` hoặc đổi namespace mẫu mỗi lần chuyển project.

Với database phục vụ bất biến, operator có thể dùng `KAG_READ_ONLY_DATABASES` hiện có để đặt đúng tên database sang native read-only của Neo4j. Sau cập nhật cấu hình phải recreate `neo4j`, rồi khởi động lại `kag-api` và `kag-builder` theo UPDATE; không đổi image pin hoặc volumes. Worker kiểm đầy đủ graph khi khởi động/kích hoạt; chỉ tái sử dụng kết quả cho cùng release còn read-only. Mỗi lần đọc vẫn kiểm identity, index, artifact nguồn và access trước/sau; citation vẫn đọc lại nguồn. Database read-write tiếp tục kiểm đầy đủ mỗi query. Lần khởi động đầu có thể lâu hơn các câu tiếp theo.

Trước khi mở ghi hoặc sửa graph ngoài Builder, dừng phục vụ `kag-api` và `kag-builder`; quản trị viên host/Neo4j phải tuân thủ ranh giới này. Sau bảo trì, đặt lại read-only và khởi động/kích hoạt để kiểm đầy đủ lại trước khi phục vụ. Không mở ghi rồi đóng lại trong lúc Chat chạy: kiểm access không phát hiện được mọi thay đổi tạm thời của superuser. Chọn database khác vẫn qua UI; cấu hình read-only không tự chuyển graph đang phục vụ.

Các cấu hình startup dưới đây dành cho release SAMPLE đóng gói sẵn; không thay lựa chọn Builder đã kích hoạt trên UI:

- **Nguồn:** `KAG_RELEASE_ID`, `KAG_WEBAPP_SNAPSHOT_ID` khớp bộ tệp trong `state/release`; xuất bản WebApp không tự đồng bộ graph.
- **Broker mặc định khi cấu hình serving:** `KAG_BROKER_URL=http://openspg-server:8899`; API cần `api-credentials/broker.token`, `sample-proof.sha256`; broker cần `broker-credentials/neo4j.password`, `broker.token` và `KAG_BROKER_DATABASE_ID`/`KAG_BROKER_SERVER_ID` đã được xác minh. Xem [backend identity](../docs/backend-identity.md).
- **Reader thay thế:** `KAG_READER_USERNAME`, `api-credentials/reader.password`, `KAG_SAMPLE_PROOF_SHA256`, endpoint chỉ đọc và mạng tới graph. Topology mặc định không nối API vào storage. Không bật reader cùng broker.
- **Mô hình:** `KAG_EMBEDDING_URL`, `KAG_EMBEDDING_MODEL`, `KAG_CHAT_URL`, `KAG_CHAT_MODEL`; keys ở `api-credentials/embedding.key`, `chat.key`, hoặc bản lưu/kiểm/áp dụng qua UI khi release tương thích. SAMPLE giữ contract 3072 chiều; graph PRODUCTION dùng namespace và dimension của phiên Builder đã xác minh, cùng đúng endpoint/model Embedding đã tạo vector.
- **Ngân sách query:** `KAG_QUERY_PROFILE=1`, `api-credentials/query-proof.sha256`, gateway và bộ đếm provider. Bật biến không tự cấp quyền provider.
- **Gateway:** `KAG_PROVIDER_ENABLED`, `KAG_CHAT_PROXY_HOST`, `KAG_CHAT_PROXY_PORT`; mặc định tắt. Host/cổng mặc định là `host.docker.internal:8317`; operator phải cung cấp proxy, repo không tự chạy nó.
- **Dataset đánh giá:** `KAG_EVALUATION_ENABLED=1`, dữ liệu đã chuẩn bị trong `release/evaluation`.

Không sửa hash/identity để ép READY. Thiếu graph/provider/nguồn phù hợp thì query chưa khả dụng; healthcheck không thay readiness. Luồng và hợp đồng: [kiến trúc](../docs/architecture.md).

Ngân sách Chat/kiểm kết nối/kiểm sẵn sàng/truy xuất dùng biến hiện có `KAG_QUERY_TIMEOUT_SECONDS` cho backend, API, Worker và gateway, nhận số nguyên 30–180 giây (mặc định 180). Thêm hoặc sửa biến này trong `.env`, rồi cập nhật `backend`, `kag-api`, `kag-builder`, `kag-ingress` theo UPDATE. API dành 5 giây cuối để trả kết quả qua backend; ví dụ cấu hình 180 cho tối đa 175 giây xử lý bên trong. Nginx chờ 190 giây, lớn hơn mọi giá trị được hỗ trợ. Mặc định này dành chỗ cho nhiều pha model cùng kiểm graph/citation trong một câu hỏi, không ép mỗi model về 25 giây. Hết ngân sách vẫn trả lỗi dịch vụ; tăng thời gian chờ không thay việc kiểm graph và nguồn.

SDK và gateway không tự retry/fallback; không tự gửi lại toàn câu hỏi. Một câu hỏi giữ giới hạn hiện có: tối đa 7 call Chat và 3 call Embedding, có thể dùng ít hơn hoặc không gọi model ở nhánh trích trực tiếp. Kết nối SDK tới gateway tối đa 2 giây (kiểm kết nối 3 giây); gateway nối endpoint tối đa 5 giây. Chờ phản hồi và đọc body cùng chịu deadline của câu hỏi. Timeout/retry nội bộ tại proxy/provider do người vận hành hệ thống đó quản lý, có thể cắt sớm hơn ngân sách LuậtGT; ứng dụng không bảo đảm hủy được việc tính phí của request đã gửi.

UI dùng kênh kết quả hiện có để nhận ID lượt hỏi sớm và gửi Dừng rõ ràng tới backend. Chỉ Dừng được server xác nhận mới lưu trạng thái đã dừng; mất kết nối được xử lý riêng. Backend ngắt HTTP xuống KAG, KAG dừng phát call mới và hủy I/O provider đang chờ khi transport hỗ trợ. Đáp án muộn không ghi đè lượt đã dừng.

### Publisher nâng cao

UI hỗ trợ graph `PRODUCTION/WRITE` đã xác minh, gồm phạm vi một phần: kiểm lại quyền, identity, graph, schema/index, model và source snapshot trước khi tạo release và đổi lựa chọn phục vụ. Release dataset mới dùng `h1-release-1.1` với `source_mode=dataset-snapshot-v1`; legacy `h1-release-1.0` vẫn giữ publication cũ. Nâng cấp không viết lại release hoặc đổi active. Database đang phục vụ được bảo vệ khỏi ghi/xóa qua Builder; tài khoản quản trị Neo4j bên ngoài vẫn phải tuân thủ bảo trì. Graph bị thay đổi ngoài luồng làm request kiểm nguồn/graph thất bại.

Lệnh dưới chỉ dành cho SAMPLE, thực hiện trong runtime backend đã có credential broker, mount run chỉ đọc và thư mục release mới ngoài source.

Ví dụ dưới dùng run `sample-run`, release mới `sample-release` và bộ nguồn `source-v1`; thay bằng các giá trị đã chuẩn bị trong runtime của bạn:

```sh
python -B -m kag.http_api.artifacts --run-directory /runs/sample-run --root /releases/sample-release --release-id sample-release --source-snapshot-id source-v1
```

Mặc định chỉ xem trước. Chỉ thêm `--approve-sample` sau khi duyệt database, dữ liệu/vector, model và phạm vi; xuất sang release mới, không ghi đè bản cũ. Tùy chọn `--webapp-publication` nhận đường dẫn bộ nguồn WebApp đã xuất bản và được kiểm; publisher không tự duyệt nội dung.

Xuất release chưa kích hoạt API: còn cần mount chỉ đọc, release ID và policy/pins đúng deployment. Publisher không tạo quyền reader hoặc xác nhận chất lượng trả lời.

## Builder

Worker chờ yêu cầu ADMIN; không tự chạy lúc startup. Người dùng chọn project theo ID và thao tác theo [runner](../docs/runner.md). Model/key lấy từ Embedding đã lưu/kiểm ở LuậtGT, không cần Apply Chat.

Deployment cấp `KAG_BUILDER_OPENSPG_URL=http://openspg-server:8887`, `KAG_BUILDER_NEO4J_HTTP=http://openspg-neo4j:7474`, `KAG_BUILDER_NEO4J_URI=bolt://openspg-neo4j:7687`. UI không đổi endpoint/credentials. `KAG_BUILDER_PROJECT_ID`, `KAG_BUILDER_PROJECT_NAME`, `KAG_BUILDER_DATABASE` chỉ gợi ý cho cấu hình cũ khi chưa có lựa chọn lưu.

`KAG_OPENSPG_PUBLIC_URL`, `KAG_NEO4J_BROWSER_URL`, `KAG_NEO4J_PUBLIC_BOLT_URL` là URL cho trình duyệt, mặc định localhost và không chứa credentials. `KAG_BUILDER_SERVING_DATABASE` lấy từ `KAG_DATABASE`; không đổi binding này để cho phép ghi vào graph đang phục vụ.

Corpus/schema được đóng gói trong image. **Kiểm tra và chuẩn bị** dùng volume `kag-builder-state` tại `/builder-state` (`KAG_BUILDER_STATE_DIR`), tách khỏi run history và source checkout. Giữ volume này khi cập nhật/backup; không mount workspace phát triển vào sản phẩm.

Config sản phẩm lưu tại `/builder-state/configuration.json`; mỗi revision giữ run root riêng dưới `/builder-runs`, khóa tại `/run/kag-locks`. `builder-input/runner.json` chỉ dành cho cấu hình Runner thủ công cũ khi chưa lưu cấu hình sản phẩm. Giữ cả Builder state, runs, locks và provider state khi backup/update. Sau restart, kiểm lại nguồn/sẵn sàng trước Resume; kết quả đã xác minh vẫn xem được khi cấu hình hiện tại thiếu hoặc đã đổi.

Mặc định thiếu đích/model nên Builder chưa sẵn sàng và báo lý do; không lấy target thử thay thế. Đích cần identity vật lý, schema và bốn vector indexes phù hợp. Chọn phạm vi, dừng/tiếp tục, bỏ phiên và dựng lại theo runner; không dùng graph serving làm đích Build.

### Cấp quyền xóa dữ liệu Builder

**Người vận hành** cấp quyền qua `KAG_BUILDER_CLEAR_TARGETS` trong `.env` tại root repository. Mặc định `[]` từ chối xóa. Cấp quyền chưa xóa dữ liệu; người dùng vẫn phải xem trước và xác nhận trên UI.

**Xóa tác động toàn bộ node, vector và quan hệ trong database chuyên dụng được cấp quyền, không chỉ một run. Phải [sao lưu](#sao-lưu) trước; không có hoàn tác nguyên tử. Không cấp quyền cho database dùng chung hoặc đang phục vụ Chat.**

#### 1. Lấy và đối chiếu đúng ID

1. Đăng nhập ADMIN LuậtGT và tài khoản sở hữu project OpenSPG, dùng cùng hostname. Tại **Dựng đồ thị → Cấu hình → Nơi lưu**, chọn **Project OpenSPG**; đọc database ở **Đích chọn**, mở **Chi tiết project** để lấy ID và namespace.
2. Mở **Configuration** của đúng project trong OpenSPG. Đối chiếu namespace, database và kết nối lưu graph. Với Compose mặc định, URI trong Docker là `neo4j://openspg-neo4j:7687`; [Neo4j Browser trên localhost](#truy-cập-quản-trị-openspg-và-neo4j) trỏ tới cùng service. Nếu deployment dùng nơi lưu khác, phải kết nối đúng nơi đó trước khi lấy ID.
3. Trong Neo4j Browser, đăng nhập bằng tài khoản quản trị đã cấu hình. Chạy từng lệnh chỉ đọc sau:

```cypher
:use system
SHOW DATABASES YIELD name, databaseID, serverID, currentStatus
RETURN name, databaseID, serverID, currentStatus;
```

4. Tìm dòng `name` khớp database ở bước 1, ví dụ `roadlaw`; cần đúng một dòng, `currentStatus=online` và `databaseID` không rỗng, không trùng database khác. Sao chép **`databaseID`**, không lấy `serverID`. Nếu thiếu quyền, thiếu cột hoặc kết quả không rõ, dừng và kiểm đúng kết nối/phiên bản; không dùng tên database thay ID.

Phân biệt các giá trị: **project ID** là số định danh project OpenSPG; **namespace** là tên không gian kiểu dữ liệu; **database** là tên như `roadlaw`; **physical database ID** là giá trị `databaseID` của database thực trong Neo4j. Cấp quyền phải ghép đúng project ID với physical database ID. Không lấy ID từ báo cáo hoặc run cũ thay catalog hiện tại.

Trước khi cấp quyền, kiểm inventory project OpenSPG và cấu hình Chat hiện có để xác nhận database này dành riêng cho project. Hai project có thể trỏ cùng database; tên hoặc namespace khác nhau chưa chứng minh cách ly. Preview chưa được cấp quyền trả `CLEAR_DENIED`, chưa hiển thị physical ID; dùng catalog Neo4j ở trên để lấy ID lần đầu.

#### 2. Lưu và áp dụng quyền

Trong `.env`, sửa dòng hiện có; không tạo hai dòng cùng tên. Ví dụ hoàn chỉnh sau dùng ID minh họa, **phải thay `123` bằng project ID vừa đối chiếu và `REPLACE_WITH_DATABASE_ID` bằng `databaseID` vừa đọc**:

```dotenv
KAG_BUILDER_CLEAR_TARGETS='[{"project_id":123,"database_id":"REPLACE_WITH_DATABASE_ID"}]'
```

Giá trị là một mảng JSON; `project_id` là số nguyên dương, `database_id` là chuỗi. Dấu nháy đơn ngoài cùng thuộc cú pháp `.env`. Nếu đã cấp quyền cho đích khác, giữ các đối tượng hiện có và thêm đối tượng mới, ngăn bằng dấu phẩy trong cùng mảng; không thay cả danh sách bằng ví dụ này.

Áp dụng theo [UPDATE](../docs/UPDATE.md): nếu Builder đang chạy, **Dừng an toàn** và chờ **Đã dừng an toàn** trước; sao lưu, giữ mapping storage và secrets, kiểm `docker compose config -q`, rồi cập nhật containers theo hướng dẫn. Worker `kag-builder` cần được tạo lại để nhận biến mới; chỉ tải lại trang hoặc `docker compose restart` không nạp lại `.env`. Không Resume tự động.

#### 3. Xem trước và xác nhận trên UI

1. Quay lại **Dựng đồ thị**, tải lại trạng thái và đăng nhập lại OpenSPG nếu cần. Kiểm cấu hình đã lưu trỏ đúng project/database. Nếu còn phiên **Đã dừng an toàn**, chỉ **Bỏ phiên** khi quyết định chấm dứt phiên đó; không bỏ phiên chỉ để lấy ID.
2. Mở **Xóa dữ liệu để dựng lại → Xem trước xóa dữ liệu**. Đọc số node/quan hệ của toàn database; mở **Danh tính đích** và đối chiếu project ID, namespace, physical database với các giá trị đã cấp.
3. Chỉ sau khi đồng ý tác động và có backup, bấm **Xóa dữ liệu đồ thị**, nhập đúng tên database rồi **Xóa dữ liệu trong roadlaw** tương ứng đích của bạn. Đợi kết quả đọc lại database rỗng; schema/index và lịch sử vẫn được giữ.

Worker vẫn kiểm quyền sở hữu, identity, database dùng chung/serving và GraphLock. Dữ liệu hoặc cấu hình thay đổi sau preview cần xem trước lại. Nếu bị chặn hoặc chưa rõ kết quả, giữ nguyên khóa và xử lý nguyên nhân; không bỏ kiểm tra để ép xóa. Chi tiết lỗi một phần và dựng lại: [runner](../docs/runner.md#xóa-dữ-liệu-đồ-thị).
