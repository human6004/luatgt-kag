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

[`docs/250/`](docs/250/) và [`docs/600/`](docs/600/) giữ ngân hàng câu hỏi nháp (`questions-draft.json`), ZIP ảnh và metadata nguồn (`question-audit.json`, trường `archives`). Nhập không tự xuất bản; kiểm đáp án, điểm liệt, ảnh và nguồn trước khi duyệt. Nội dung xuất bản WebApp không tự đồng bộ graph KAG.

Thi thật hạng B dùng server và đáp án đã duyệt; các giới hạn học/thi, chatbot và Builder nằm trong USER-GUIDE.

## Nhập ngân hàng bằng script

Lựa chọn thay cho nhập UI, sau khi stack đã chạy. Dùng credentials ADMIN hiện tại và chọn đúng installation trước khi nhập.

1. Trong **Câu hỏi thi → Bộ câu hỏi & Quy tắc thi**, tạo **hai bộ riêng** cho ngân hàng 250 và 600 câu.
2. Lấy UUID của từng bộ trên chính installation người nhận: mở Developer Tools của trình duyệt → Network, tải lại trang Câu hỏi thi, xem response của GET `/api/admin/questions/sets`. Đối chiếu `set_name`/`set_code` và chép `set_id` tương ứng. UUID có dạng chuẩn 8-4-4-4-12 ký tự hexadecimal, không gồm dấu ngoặc. **Hai bộ phải dùng hai UUID khác nhau**; không dùng UUID máy khác hoặc hardcode UUID vào script.
3. Từ root repository, đặt hai biến bằng UUID vừa lấy rồi chạy lần lượt:

```powershell
$set250Id = Read-Host 'UUID bộ 250 của installation này'
$set600Id = Read-Host 'UUID bộ 600 của installation này'
if ($set250Id -eq $set600Id) { throw 'Hai bộ phải dùng hai UUID khác nhau.' }
./WebApp/scripts/import-question-bank.ps1 -Set 250 -SetId $set250Id
./WebApp/scripts/import-question-bank.ps1 -Set 600 -SetId $set600Id
```

4. Kiểm tổng kết có đúng tiền tố bộ/UUID, số thêm/bỏ qua/cập nhật và ảnh đã ghép/chưa khớp. Với hai bộ mới trống, dự kiến thêm 250 và 600 câu, bỏ qua/cập nhật 0; ghép 125 và 318 ảnh, chưa khớp 0. Trong UI, lọc từng bộ và đối chiếu câu/ảnh, đặc biệt Q329/Q457 chỉ có ảnh ở bộ 600 theo gói hiện tại. Kiểm nguồn/đáp án/điểm liệt rồi mới duyệt xuất bản.

`-Set` chọn dữ liệu nguồn; `-SetId` chọn bộ đích. Script kiểm UUID/bộ tồn tại trước khi ghi, truyền cùng questionSetId cho câu hỏi và ZIP; backend tách ID theo bộ, giữ mã nguồn để ghép ảnh. Hai JSON và ZIP nguồn giữ nguyên.

Bộ đã có câu hỏi **hoặc bản nháp**: script cảnh báo rồi dừng, chưa ghi. Chỉ thêm `-Force` sau khi đã kiểm đúng bộ đích và muốn nhập tiếp/chạy lại, ví dụ `./WebApp/scripts/import-question-bank.ps1 -Set 250 -SetId $set250Id -Force`. Cờ này xác nhận nhập vào bộ có dữ liệu; mã đã tồn tại trong bộ vẫn bị bỏ qua (`updateExisting=false`), ảnh đã có giữ nguyên. Không dùng cùng UUID cho hai ngân hàng; script không tự chuyển hoặc sửa các câu LEGACY đã nhập trước đây.

Có thể truyền `-EnvFile` nếu cấu hình installation ở vị trí khác; cổng khác mặc định truyền `-BaseUrl` đúng API. Script ghi câu hỏi nháp và ảnh vào backend đã chọn; nhập không tự xuất bản.

`scripts/verify-stack.ps1` là kiểm thử tùy chọn, tạo tài khoản/lịch sử thử; `-WithExam` cần dữ liệu đã xuất bản. Đọc source và chọn môi trường thử riêng trước khi chạy; không phải điều kiện startup.
