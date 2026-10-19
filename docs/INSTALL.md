# Cài đặt LuậtGT trên Windows

Dùng cho lần cài đầu. Máy đã có dữ liệu làm theo [UPDATE](UPDATE.md); giữ `.env`, secrets và storage đang dùng.

## 1. Chuẩn bị công cụ

Cài [Git for Windows](https://git-scm.com/install/windows) và [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Bật ảo hóa/WSL 2 theo yêu cầu Docker, chọn Linux containers và chờ Docker Engine chạy.

Mở PowerShell:

```powershell
docker version
docker compose version
```

Cần thấy cả Docker Client/Server. Compose từ **2.20.3** để hỗ trợ `include`. Không cần Python, Java hoặc Node trên host. Build cần mạng để tải source/images/dependencies; dự án chưa công bố cấu hình RAM/disk tối thiểu đã đo.

## 2. Lấy source

Tại thư mục muốn chứa dự án:

```powershell
git clone --recurse-submodules https://github.com/human6004/luatgt-kag.git
Set-Location luatgt-kag
```

Kiểm có `.env.example`, `docker-compose.yml` và `vendor/KAG`. **Mọi lệnh còn lại chạy tại thư mục gốc `luatgt-kag`, trong cùng cửa sổ PowerShell.** Compose chính tự include KAG; không cần ghép hai file bằng `-f`.

## 3. Tạo cấu hình và secrets

Đoạn lệnh sau tạo `.env` từ template nếu chưa có, sinh 9 mật khẩu/khóa độc lập và 7 token nội bộ. Mỗi giá trị mới gồm 32 byte ngẫu nhiên, lưu thành 64 ký tự hexadecimal; file đã tồn tại được giữ nguyên.

Nếu được cấp `.env` cho lần cài mới, đặt file đó tại root trước khi chạy. Không dùng đoạn này để thay bộ secrets của máy đã có database.

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

Kết quả mặc định:

- `.env`: mật khẩu và biến triển khai; xem `ADMIN_EMAIL`/`ADMIN_PASSWORD` để đăng nhập.
- `.secrets/`: bốn file `query.token`, `inspect.token`, `builder.token`, `egress.token`.
- `../luatgt-state/`: ba file `credentials-write.token`, `provider-test.token`, `config-apply.token` cho lưu/kiểm/áp dụng model.

Đường dẫn thực tế lấy từ `KAG_STATE_DIR` và ba biến `KAG_*_SECRET_FILE` trong `.env`. Không commit `.env`, token hoặc backup; giới hạn quyền đọc cho người vận hành và Docker Desktop. Giữ chúng khi cập nhật.

Có thể mở cấu hình tại máy riêng:

```powershell
notepad .env
```

Đổi email Admin trước lần khởi động đầu nếu muốn. Mặc định project là `luatgt`, state là `./.secrets`. Không đổi mật khẩu trong `.env` để đặt lại tài khoản/database đã tồn tại.

## 4. Khởi động

Kiểm cú pháp trước, chỉ khởi động khi lệnh đầu không báo lỗi:

```powershell
docker compose config -q
docker compose up -d --build
docker compose ps -a
```

Compose build image từ source và khởi động 12 services. Image ứng dụng `luatgt-kag:local` được build tại máy, không cần tìm nó trên Docker Hub; base images/dependencies vẫn cần được tải khi chưa có cache.

Đợi lệnh kết thúc và xem trạng thái services. Service có healthcheck cần chuyển sang `healthy`; service còn `Exited`, `Created` hoặc `Unhealthy` cần đọc log theo [Docker](../docker/README.md#vận-hành). Exit code/healthcheck không tự chứng minh chatbot dùng được.

## 5. Đăng nhập và kiểm cơ bản

1. Mở [WebApp](http://127.0.0.1:8081), đăng nhập bằng `ADMIN_EMAIL`/`ADMIN_PASSWORD` vừa chuẩn bị. Backend tạo ADMIN ở lần đầu; không có mật khẩu quản trị chung trong tài liệu.
2. Kiểm mở được tổng quan và các trang nội dung. USER có thể tự đăng ký từ màn đăng nhập.
3. Xem [USER-GUIDE](USER-GUIDE.md) để nhập bản nháp, kiểm duyệt và xuất bản nội dung cho người dùng.

Cài mới chưa tự nạp dữ liệu nghiệp vụ hoặc graph. Nguồn luật trong image là đầu vào Builder, không tự được xuất bản vào WebApp MySQL.

## Cấu hình tiếp theo theo nhu cầu

- **Học/thi:** nhập và xuất bản câu hỏi, ảnh, biển báo theo [USER-GUIDE](USER-GUIDE.md#adminpolice--nội-dung).
- **Dựng graph:** theo [Builder](runner.md) để tạo Knowledge Base, chọn project và chuẩn bị cấu trúc dữ liệu/index trên UI.
- **Hỏi luật bằng Chat:** xem **Dữ liệu nguồn**, dựng graph bằng Builder, lưu/kiểm model tại **Cài đặt hệ thống → Model & tìm kiếm**, rồi [chọn graph và xác nhận dùng cho Chat](runner.md#chọn-graph-phục-vụ-truy-xuấtchat). Nhánh dataset dùng nguồn đi cùng graph, không phải nhập lại MySQL. Máy mới cần tự cấu hình model/provider và project của mình; chưa cấu hình thì UI hướng dẫn, không dùng graph mẫu. Build xong chưa tự đổi graph phục vụ.
- **Quản trị OpenSPG/Neo4j:** [URL và tài khoản](../docker/README.md#truy-cập-quản-trị-openspg-và-neo4j). Các tài khoản này độc lập với WebApp.

Các thao tác kiểm model, lưu model/Knowledge Base trong OpenSPG và dựng graph có thể gọi dịch vụ model tính phí. Khởi động ứng dụng không yêu cầu tự chạy các thao tác này.

## Lỗi thường gặp

| Hiện tượng | Kiểm tra |
| --- | --- |
| Không thấy Docker Server | Mở Docker Desktop, kiểm Linux containers và WSL 2 |
| Thiếu biến hoặc token | Kiểm Bước 3 và đường dẫn `.env`; dùng `docker compose config -q` để kiểm cú pháp |
| Cổng đã được dùng | Đối chiếu [cổng và mạng](../docker/README.md#cổng-và-mạng); nếu đổi cổng quản trị, giữ bind `127.0.0.1` và cập nhật URL tương ứng |
| WebApp lỗi 502 | Xem log backend/frontend, không tạo lại mật khẩu hoặc xóa dữ liệu |
| Đăng nhập trả 401 | Kiểm đúng tài khoản của hệ thống đang dùng; đổi `.env` không đặt lại mật khẩu cũ |
| Build không tải dependency/image | Kiểm mạng và registry; không tự đổi image pin để vượt lỗi |

Dừng/chạy lại theo [Docker](../docker/README.md#vận-hành). Không dùng `down -v`, prune hoặc xóa volumes để sửa lỗi.

Hướng dẫn đã được đối chiếu source; chưa xác minh trọn quy trình cài trên máy sạch.
