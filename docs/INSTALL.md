# Cài đặt LuậtGT trên Windows

Dành cho lần cài đầu. Máy đã có dữ liệu dùng [UPDATE](UPDATE.md), không tạo lại secrets.

## Bước 1 — Cài công cụ

Cài [Git for Windows](https://git-scm.com/install/windows) và [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) theo yêu cầu Windows/WSL 2 của Docker. Bật ảo hóa, chọn Linux containers và đợi Docker Engine chạy.

Compose cần **từ 2.20.3** để hỗ trợ [include](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/). Không cần Python, Java hay Node trên host. Dự án chưa công bố cấu hình máy tối thiểu đã đo; cần đủ RAM/disk cho 12 services, build và sao lưu.

Mở PowerShell, kiểm engine và Compose:

```powershell
docker version
docker compose version
```

Kết quả: thấy Docker Client/Server và phiên bản Compose phù hợp. Build cần mạng để tải source, images và dependencies.

## Bước 2 — Tải source

Chạy tại thư mục muốn chứa dự án:

```powershell
git clone --recurse-submodules https://github.com/human6004/luatgt-kag.git
Set-Location luatgt-kag
```

Kết quả: có source và `vendor/KAG` đúng phiên bản. **Các lệnh còn lại chạy tại thư mục gốc này, trong cùng cửa sổ PowerShell.** Source được cấp riêng cũng phải có `.env.example` và Compose chính tự include file KAG; không dùng hướng dẫn stack cũ để bù file thiếu.

## Bước 3 — Tự động tạo mật khẩu và token

Chạy trong thư mục gốc `luatgt-kag`. Đoạn PowerShell dưới đây tạo `.env` nếu chưa có, với **9 mật khẩu/khóa độc lập**, mỗi giá trị là 64 ký tự hexadecimal ngẫu nhiên, và tạo các token còn thiếu. Nếu đã được cấp `.env` để cài mới trên máy riêng, giữ file đó và chạy cùng đoạn lệnh để tự tạo 7 token. `.env` và token đã tồn tại không bị ghi đè. Máy có database cũ phải giữ bộ secrets tương ứng, dùng [UPDATE](UPDATE.md).

```powershell
$ErrorActionPreference = 'Stop'
$createEnv = -not (Test-Path -LiteralPath .env)
$envSource = if ($createEnv) { '.env.example' } else { '.env' }
$content = [IO.File]::ReadAllText((Join-Path $PWD.Path $envSource))
$stateSetting = [regex]::Match($content, '(?m)^KAG_STATE_DIR=([^\r\n]+)')
if (-not $stateSetting.Success) { throw 'Cần đặt KAG_STATE_DIR trong .env hoặc .env.example.' }
$statePath = $stateSetting.Groups[1].Value.Trim().Trim([char]34, [char]39)
if ([string]::IsNullOrWhiteSpace($statePath)) { throw 'KAG_STATE_DIR không được để trống.' }
$state = [IO.Path]::GetFullPath((Join-Path $PWD.Path $statePath))
$tokenNames = @('query', 'inspect', 'builder', 'egress')
$tokenFiles = @($tokenNames | ForEach-Object { Join-Path $state "$_.token" })
foreach ($entry in @(@('KAG_CREDENTIALS_WRITE_SECRET_FILE', 'credentials-write'),
                     @('KAG_PROVIDER_TEST_SECRET_FILE', 'provider-test'), @('KAG_CONFIG_APPLY_SECRET_FILE', 'config-apply'))) {
    $setting = [regex]::Match($content, "(?m)^$($entry[0])=([^\r\n]+)")
    $path = if ($setting.Success) { $setting.Groups[1].Value.Trim().Trim([char]34, [char]39) } else { "../luatgt-state/$($entry[1]).token" }
    $tokenFiles += [IO.Path]::GetFullPath((Join-Path $PWD.Path $path))
}

$keys = @('ADMIN_PASSWORD', 'DB_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'REDIS_PASSWORD',
          'JWT_SECRET', 'MINIO_PASSWORD', 'KAG_MYSQL_PASSWORD',
          'KAG_NEO4J_PASSWORD', 'KAG_MINIO_PASSWORD')
foreach ($key in $keys) {
    if ($createEnv -and $content -notmatch "(?m)^$key=(?=\r?$)") { throw "Thiếu ô trống $key trong .env.example" }
    if (-not $createEnv -and $content -notmatch "(?m)^$key=\S+(?=\r?$)") { throw "Thiếu giá trị $key trong .env" }
}

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    foreach ($key in $(if ($createEnv) { $keys })) {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        $secret = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        $content = [regex]::Replace($content, "(?m)^$key=(?=\r?$)", "$key=$secret")
    }
    [IO.Directory]::CreateDirectory($state) | Out-Null
    foreach ($tokenPath in $tokenFiles) {
        if (Test-Path -LiteralPath $tokenPath) { continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($tokenPath)) | Out-Null
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        $secret = [Text.Encoding]::ASCII.GetBytes([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
        $file = [IO.File]::Open($tokenPath, [IO.FileMode]::CreateNew)
        try { $file.Write($secret, 0, $secret.Length) } finally { $file.Dispose() }
    }
    if ($createEnv) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($content)
        $file = [IO.File]::Open((Join-Path $PWD.Path '.env'), [IO.FileMode]::CreateNew)
        try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
    }
} finally { $rng.Dispose() }
Write-Host 'Đã chuẩn bị .env và token; giữ nguyên các file đã có. Xem ADMIN_EMAIL / ADMIN_PASSWORD trong .env để đăng nhập.'
```

Sau khi chạy, mở `notepad .env` để xem và **lưu lại** `ADMIN_EMAIL` cùng `ADMIN_PASSWORD`. Có thể đổi email Admin trước khi chạy Docker. Cài mới dùng `COMPOSE_PROJECT_NAME=luatgt` và `KAG_STATE_DIR=./.secrets`. Thư mục `.secrets/` nằm trong repo local nhưng không được đưa lên GitHub hoặc vào Docker build context. Không commit `.env` và token; mỗi máy nên tạo bộ secrets riêng.

## Bước 4 — Kiểm tra token đã tạo

Bốn file `query.token`, `inspect.token`, `builder.token`, `egress.token` nằm trong thư mục được chỉ định bởi `KAG_STATE_DIR`. Với cài mới mặc định, kiểm tra:

```powershell
Get-ChildItem .\.secrets -Filter *.token -Name
```

Ba token riêng `credentials-write.token`, `provider-test.token`, `config-apply.token` dùng cho Save, Test và Apply model; mặc định ở `../luatgt-state/` ngoài repository. Đường dẫn tương ứng: `KAG_CREDENTIALS_WRITE_SECRET_FILE`, `KAG_PROVIDER_TEST_SECRET_FILE`, `KAG_CONFIG_APPLY_SECRET_FILE`. Không dùng lại query/inspect token. Compose mount read-only vào backend và KAG API. Khi cập nhật cài đặt cũ, chạy lại Bước 3 để tạo token còn thiếu trước khi recreate hai service.

Save model lưu key trong file riêng quyền `0600` trên volume provider-state, không thay cấu hình Retrieval hoặc runtime. API chỉ trả metadata và trạng thái key. Đây không phải mã hóa; bảo vệ quyền đọc và mọi bản sao volume. Save không cấp quyền Test/Apply hoặc mở provider egress.

Trong Admin → Cấu hình, lưu độc lập API type OpenAI-compatible, Base URL, model và key cho Chat/Embedding, rồi chọn Kiểm tra và xác nhận chi phí. Test gửi một request từ KAG, không tự retry, đổi key hay model. `KAG_PROVIDER_ENABLED=1` bật gateway; KAG API vẫn không có outbound trực tiếp.

API và HAProxy dùng chung [provider-hosts.lst](../docker/kag-ingress/provider-hosts.lst): mỗi dòng một hostname HTTPS công khai, viết thường, không wildcard/port/path. Mặc định cho phép ViLao, OpenAI, OpenRouter và Gemini OpenAI-compatible. Có thể đặt `KAG_PROVIDER_HOSTS_FILE` tới file deployment khác. Đổi model/key/Base URL trên host đã được phép chỉ cần UI; host mới cần người vận hành bổ sung policy và recreate `kag-api`, `kag-ingress`. URL ngoài policy vẫn lưu được nhưng Test báo BLOCKED. Gateway kiểm DNS/IP, ghim IP công khai, xác minh TLS theo hostname, không theo redirect; hiện chỉ định tuyến IPv4 và HTTPS cổng 443. Base URL giữ prefix API của provider, ví dụ `/api/v1` hoặc `/v1beta/openai`; không tự đổi URL/model đã lưu.

EvelProxy không bắt buộc. Proxy nội bộ chỉ được đăng ký rõ bằng `KAG_PROVIDER_PROXY_BASE_URL`; URL logic này ánh xạ tới `KAG_CHAT_PROXY_HOST:KAG_CHAT_PROXY_PORT` hiện có. Đặt `KAG_CHAT_PROXY_TEST_SAFE=1` khi đã xác minh proxy không retry, xoay credential hoặc fallback. Nếu operator chấp nhận chi phí và các lượt thử nội bộ của proxy, dùng `KAG_CHAT_PROXY_ALLOW_UPSTREAM_RETRIES=1`; cờ này không xác nhận proxy đã tắt retry. Chưa có một trong hai policy thì Test route proxy bị chặn; provider HTTPS khác vẫn độc lập. Các route/proof SAMPLE cũ giữ ràng buộc riêng.

Test PASS gắn với revision của từng nhóm. Chat PASS khi API trả thành công và có nội dung; Embedding kiểm vector numeric và ghi số chiều thực đo. UI hiển thị tên model thực nhận nếu provider trả về, kể cả khi khác tên gửi. Test xác nhận API hoạt động, không tự xác nhận identity backend hoặc khả năng dùng vector với graph. Số retry nội bộ của proxy/provider ngoài KAG không quan sát được. Apply chỉ chạy khi runtime rảnh và endpoint/model yêu cầu khớp provenance, cache và serving release đã kiểm chứng; cùng số chiều không đủ để Apply, thiếu release thì báo BLOCKED. Chat consumer nhận tên phản hồi từ đúng bản Test đã Apply; phản hồi khác bản đã Test vẫn bị chặn. Restart khôi phục bản active, không tự áp dụng bản mới lưu.

Builder dùng cấu hình Embedding đã lưu và kiểm tra, không cần Apply cho Chat. Hạ tầng cấp kết nối private theo [Runner](runner.md#đích-builder-trong-deployment). Người dùng tạo Knowledge Base riêng trong OpenSPG; trong **Dựng đồ thị**, chuẩn bị nguồn → chọn project → **Xem thay đổi → Chuẩn bị cấu trúc LuậtGT → Xác nhận chuẩn bị** → lưu cấu hình → kiểm sẵn sàng → xác nhận Build → xem kết quả. Nguồn và schema đi kèm image; không cần graph plan, script ngoài project hoặc Cypher chuẩn bị index thông thường. Build gọi provider thật; đặt hạn mức request hoặc chủ động chọn **Không giới hạn**. Giới hạn nội dung để trống là toàn corpus, số 0 không hợp lệ. Không hỗ trợ upload corpus hay OpenIE tùy ý. Kết quả Build không tự kích hoạt Chat.

Runner hoàn tất chưa tự phê duyệt phục vụ. Với graph `FRESH_SAMPLE/WRITE` đã xác minh, operator có thể chạy publisher trong môi trường backend có credential broker hiện hữu, mount run chỉ đọc và thư mục release mới ngoài source:

```sh
python -B -m kag.http_api.artifacts --run-directory /runs/<run-id> --root /releases/<release-id> --release-id <release-id> --source-snapshot-id <source-id>
```

Mặc định chỉ xem trước, không ghi release. Sau khi duyệt đúng database identity, fingerprint, provenance, model và số lượng, thêm `--approve-sample` để xuất bản; publisher kiểm lại graph/index và database read-only, không ghi đè release cũ. Kích hoạt API vẫn cần mount release chỉ đọc, chọn `KAG_RELEASE_ID` và cấp operational proof/pin phù hợp với isolation thực tế. Publisher không tạo quyền reader, không tự kích hoạt và không xác nhận chất lượng câu trả lời.

Để phục vụ Chat, có thể thêm `--webapp-publication <snapshot.json>` từ dữ liệu WebApp đã xuất bản và được duyệt. Publisher kiểm source ID, schema và hash nội dung từng unit rồi niêm phong snapshot cùng release mới; không sửa release đang phục vụ hoặc tự đánh dấu nội dung đã duyệt.

Đoạn lệnh ở Bước 3 đọc đường dẫn từ `.env` nếu file đã tồn tại. Cài đặt cũ dùng `../luatgt-state` vẫn giữ nguyên đường dẫn đó. **Không xóa hay tạo lại secrets của lần cài trước.** Khi dùng đường state khác, thay đường dẫn trong lệnh kiểm tra cho khớp.

Trong **Properties → Security**, giới hạn quyền đọc `.env` và state cho người vận hành, giữ quyền Docker Desktop cần để đọc chúng. Chưa cần tạo graph ở bước này.


## Bước 5 — Khởi động

Sau khi hoàn tất tạo `.env` và 7 token, chạy tại thư mục gốc `luatgt-kag`:

```powershell
docker compose up -d --build
```

Docker Compose sẽ tự build các image cần thiết và khởi động 12 services trong project `luatgt`.

Image `luatgt-kag:local` được build từ source code trong repository, không cần tải từ Docker Hub hoặc đăng nhập Docker Hub.

Compose chính tự include `docker-compose.kag.yml`. Không cần chạy KAG riêng hoặc ghép hai file bằng `-f`.

Lần cài đầu có thể mất nhiều thời gian vì Docker cần tải images và dependencies. Hãy đợi lệnh chạy xong.

Sau đó kiểm tra:

```powershell
Write-Host "Exit code: $LASTEXITCODE"
docker compose ps -a
```

Nếu exit code là `0`, lệnh Compose đã hoàn thành thành công. Tiếp tục kiểm tra trạng thái các services.

Nếu exit code khác `0`, hoặc có service `Exited` hoặc `Unhealthy`, kiểm tra log của service đó trước khi tiếp tục.

Không xóa Docker volumes, không tạo lại `.env` hoặc token để xử lý lỗi khởi động.


## Bước 6 — Mở WebApp

```powershell
docker compose ps -a
```

Kết quả: 12 services được khởi động; các service có healthcheck chuyển sang `healthy`. Mở [WebApp](http://127.0.0.1:8081), dùng ADMIN ở Bước 3 hoặc chọn **Chưa có tài khoản? Đăng ký** để tạo USER. ADMIN vào tổng quan; USER vào chat. Đổi `.env` không đặt lại mật khẩu tài khoản cũ.

ADMIN nhập và duyệt nội dung theo [USER-GUIDE](USER-GUIDE.md). Dữ liệu trong repo không tự nạp vào MySQL/graph. Chatbot cần [cấu hình riêng](../docker/README.md#cấu-hình-chatbot); cài mặc định chưa sẵn sàng để hỏi luật hoặc dựng graph production.

Quản trị graph: [OpenSPG](http://127.0.0.1:8887/) và [Neo4j Browser](http://127.0.0.1:7474/browser/), chỉ từ localhost. Tài khoản OpenSPG, Neo4j và WebApp riêng nhau; nơi lấy credentials và cách chọn database nằm trong [hướng dẫn quản trị](../docker/README.md#truy-cập-quản-trị-openspg-và-neo4j). Tạo Knowledge Base và chuẩn bị cấu trúc trên UI theo [Runner](runner.md#chọn-project-và-nạp-schema), không tự tạo graph sau `compose up`.

**Chưa xác minh trọn quy trình trên máy sạch.** Các bước trên được đối chiếu source local; khởi động container không xác nhận chất lượng chatbot.

## Lỗi thường gặp

- Không kết nối Docker: mở Docker Desktop, kiểm Linux containers/WSL 2.
- Thiếu cấu hình/token: kiểm Bước 3–4; có thể chạy `docker compose config -q` mà không khởi động.
- Cổng bị dùng: đổi biến cổng WebApp tương ứng theo [Docker](../docker/README.md#cổng-và-mạng). Ba cổng quản trị 7474/7687/8887 nằm ở `kag-ingress` trong `docker-compose.kag.yml`; nếu đổi host port phải giữ `127.0.0.1` và cập nhật URL/Connect URL của Browser tương ứng.
- WebApp lỗi `502`: xem log backend/frontend theo [vận hành Docker](../docker/README.md#vận-hành). Sai email/mật khẩu trả `401`.
- Build không tải dependencies: kiểm thông báo mạng/registry; không đổi image pin tùy tiện.

Dừng/chạy lại theo [Docker](../docker/README.md#vận-hành). Không dùng `down -v`, xóa volumes hoặc prune để sửa lỗi.
