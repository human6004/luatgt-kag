# Cập nhật LuậtGT, giữ dữ liệu

Ví dụ: người phát triển push bản mới có thay đổi giao diện, Backend hoặc KAG. Máy đang chạy bản cũ làm đủ các bước dưới đây để lấy source mới và cập nhật toàn bộ ứng dụng, giữ dữ liệu đã có. Không cần tự chọn service để rebuild.

Chạy lệnh tại thư mục repository trên máy cần cập nhật, dùng đúng project và `.env` đang phục vụ. Cần thời gian bảo trì. Không tạo lại secrets, chép đè `.env`, dùng `down -v`, prune hoặc reset dữ liệu.

## Bước 1 — Chuẩn bị và sao lưu

```powershell
git status --short
docker compose ps -a
```

Nếu Git báo có code sửa riêng, giữ và xử lý các thay đổi đó trước khi pull; không reset hoặc tự stash.

Thực hiện [sao lưu Docker](../docker/README.md#sao-lưu): ngừng thao tác trên WebApp, dừng Builder an toàn rồi dừng services:

```powershell
docker compose stop -t 120
```

Sao lưu `.env`, Compose, state và **mọi volume đang mount** ra ngoài repo; ghi lại phiên bản source/image và mapping volume theo hướng dẫn trên. **Chỉ tiếp tục khi services đã dừng và sao lưu hoàn tất.** Nếu máy còn hai projects cũ hoặc mapping khác source, cần quy trình chuyển đổi riêng.

## Bước 2 — Lấy phiên bản mới

Giữ nhánh đang theo phiên bản cần cập nhật. Chạy từng lệnh:

```powershell
git pull --ff-only
git submodule update --init vendor/KAG
```

Lệnh đầu lấy code đã push; lệnh sau lấy đúng phiên bản KAG được ghim. Nếu một lệnh lỗi, dừng xử lý trước khi chạy tiếp; không force/reset hoặc dùng `submodule update --remote`.

## Bước 3 — Giữ cấu hình và storage

Nếu phiên bản mới thêm biến cấu hình, đối chiếu `.env.example` và bổ sung vào `.env` đang có. Giữ project, `KAG_STATE_DIR`, mật khẩu/token và [mapping storage](../docker/README.md#storage-và-secrets). Đổi biến password không tự đổi password database/ADMIN.

Giữ volume `kag-builder-state` cùng runs, locks và provider state. Builder lưu cấu hình và kế hoạch nguồn trong volume này; sau restart, kiểm lại nguồn và sẵn sàng trước khi Tiếp tục. Cập nhật Worker/API/backend/frontend đồng bộ để dùng tiến trình và kết quả mới.

Nếu có thay đổi Compose, database image hoặc schema, đọc hướng dẫn migration của phiên bản đó; đối chiếu tên volume **và đường mount** với bản đã sao lưu. Không thay mapping bằng giá trị mặc định hoặc chạy hai databases trên cùng volume.

```powershell
docker compose config -q
```

Chỉ tiếp tục nếu cấu hình không báo lỗi. Lệnh này không kiểm tra tính tương thích của storage/migration. Không chia sẻ output đầy đủ của `compose config` vì có thể chứa secrets.

## Bước 4 — Chạy phiên bản mới

```powershell
docker compose up -d --build
docker compose ps -a
```

`up -d --build` build lại phần thay đổi và cập nhật containers cần thiết, dùng lại volumes hiện có. Không cần build từng service riêng. Kiểm đủ 12 services đang chạy; những service có healthcheck cần chuyển sang `healthy`. Nếu `up` lỗi, kiểm log trước khi tiếp tục; không xóa volume để xử lý.

## Bước 5 — Kiểm dữ liệu cũ

Mở WebApp tại cổng đang dùng, nhấn **Ctrl+F5** để tải giao diện mới. Đăng nhập bằng tài khoản cũ; kiểm nội dung, ảnh/tệp và lịch sử chat/thi. ADMIN kiểm Hạ tầng, Graph SAMPLE và Builder theo [USER-GUIDE](USER-GUIDE.md#admin--kag-và-hạ-tầng).

Nếu chatbot đã được cấu hình, kiểm readiness và thử một câu trong phạm vi phục vụ; có thể phát sinh phí provider. Container `healthy` chưa chứng minh chatbot trả lời được. Nếu nguồn/identity không khớp, kiểm [cấu hình chatbot](../docker/README.md#cấu-hình-chatbot), không sửa hash để ép READY.

Giữ backup đến khi dữ liệu cũ và chức năng đã cấu hình được kiểm tra xong. Nếu cần phục hồi, dừng ghi và thử bản sao trên storage riêng; không import đè volume đang phục vụ. Hạ source/image không tự đảo ngược migration.

Quy trình giữ dữ liệu theo storage của Compose; **chưa xác minh cập nhật và phục hồi thực tế cho source hiện tại**.
