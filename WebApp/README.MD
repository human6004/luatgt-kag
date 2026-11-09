# WebApp LuậtGT

React cung cấp giao diện USER/ADMIN; Spring Boot quản lý nghiệp vụ, dùng MySQL, Redis, MinIO và gọi KAG Python.

- [INSTALL](../docs/INSTALL.md): cài và đăng nhập.
- [USER-GUIDE](../docs/USER-GUIDE.md): thao tác và giới hạn chức năng.
- [UPDATE](../docs/UPDATE.md), [Docker](../docker/README.md): vận hành và giữ dữ liệu.
- [Frontend](frontend/README.md), [backend](backend/README.md), [rule.md](rule.md): phát triển và quy tắc dự án.

## WebApp khi chưa chạy KAG

Chuẩn bị `.env` và token theo [INSTALL](../docs/INSTALL.md); giữ project, secrets và storage hiện có. Các lệnh Docker dưới đây chạy từ **root repository**, dùng Compose và `.env` chung.

Chỉ bật `mysql`, `redis`, `minio`, `backend`, `frontend`; chat KAG, graph và Builder chưa khả dụng. Các lệnh này không dừng KAG nếu đã chạy sẵn.

**Build FE/BE:** lần đầu hoặc sau khi đổi source:

```powershell
docker compose build backend frontend
```

Muốn build riêng, chỉ ghi `backend` hoặc `frontend`. Build tạo image; bước chạy bên dưới áp dụng image vào container.

**Chạy hoặc chạy lại sau khi dừng:** chạy lần lượt, đợi lệnh đầu thành công:

```powershell
docker compose up -d --wait mysql redis minio
docker compose up -d --no-deps backend frontend
```

`--wait` đợi dependencies sẵn sàng theo healthcheck hiện có; `--no-deps` tránh backend tự kéo KAG lên. Mở [WebApp](http://127.0.0.1:8081), hoặc cổng `WEBAPP_PORT` trong `.env`. Sau khi build lại, dùng lại các lệnh trên để cập nhật container.

**Dừng, xem trạng thái và log:**

| Thao tác | Lệnh tại root repository |
|---|---|
| Dừng WebApp, giữ container và dữ liệu | `docker compose stop frontend backend mysql redis minio` |
| Xem trạng thái | `docker compose ps -a mysql redis minio backend frontend` |
| Theo dõi log FE/BE | `docker compose logs -f --tail 100 backend frontend` |

Đổi tên service trong lệnh log để xem MySQL/Redis/MinIO. `Ctrl+C` chỉ thoát theo dõi log. Không dùng `down -v` hoặc prune để dừng ứng dụng.

**FE bằng `pnpm dev`, BE bằng Docker:**

Chạy dependencies như trên, thay lệnh chạy FE/BE bằng `docker compose up -d --no-deps backend`. Nếu FE Docker đang chạy, dừng bằng `docker compose stop frontend`. Cài Node/dependencies theo [Frontend — Bước 1](frontend/README.md#phát-triển-và-kiểm-thử), rồi từ root repository:

```powershell
Set-Location WebApp/frontend
pnpm dev -- --port 5174
```

Mở [FE dev](http://127.0.0.1:5174); `/api` được proxy tới backend ở `127.0.0.1:8080`. Nếu đổi `BACKEND_PORT`, chỉnh đích proxy trong [vite.config.ts](frontend/vite.config.ts) cho khớp. Sửa FE được Vite cập nhật khi dev server đang chạy; sửa BE thì build và chạy lại riêng `backend` như trên. `Ctrl+C` dừng FE dev; khởi động lại bằng cùng lệnh pnpm. Quay về root repository trước khi dùng các lệnh Docker dừng/chạy lại.

## Dữ liệu và nghiệp vụ

[`docs/imports/`](docs/imports/) giữ ngân hàng câu hỏi nháp/ZIP ảnh/metadata nguồn. Nhập không tự xuất bản; kiểm đáp án, điểm liệt, ảnh và nguồn trước khi duyệt. Nội dung xuất bản WebApp không tự đồng bộ graph KAG.

Thi thật hạng B dùng server và đáp án đã duyệt; các giới hạn học/thi, chatbot và Builder nằm trong USER-GUIDE.

## Nhập ngân hàng bằng script

Lựa chọn thay cho nhập UI, sau khi stack đã chạy. Từ root repository:

**Bước 1:** chạy công cụ có sẵn để nhập nháp và ghép ảnh, bỏ qua mã đã tồn tại:

```powershell
./WebApp/scripts/import-question-bank.ps1 -EnvFile .env
```

Kết quả: số thêm/bỏ qua và ảnh ghép. Cổng khác mặc định truyền `-BaseUrl` đúng API; dùng credentials ADMIN hiện tại.

**Bước 2:** mở Ngân hàng câu hỏi, kiểm nguồn/đáp án/điểm liệt/ảnh rồi xuất bản câu thật đủ điều kiện.

`scripts/verify-stack.ps1` là kiểm thử tùy chọn, tạo tài khoản/lịch sử thử; `-WithExam` cần dữ liệu đã xuất bản. Đọc source và chọn môi trường thử riêng trước khi chạy; không phải điều kiện startup.
