# Cập nhật LuậtGT, giữ dữ liệu

Dùng trên máy đã cài LuậtGT. Các lệnh PowerShell chạy tại **root repository**, với đúng `.env` và Compose project đang dùng. Cần thời gian bảo trì.

## 1. Chuẩn bị và sao lưu

```powershell
git status --short
docker compose ps -a
```

Nếu có thay đổi source riêng, bảo toàn và xử lý trước khi lấy bản mới; không reset hoặc tự stash. Ghi lại commit, image IDs, cấu hình và mapping storage theo [Sao lưu Docker](../docker/README.md#sao-lưu).

Ngừng thao tác trên WebApp. Nếu Builder đang chạy, bấm **Dừng** và chờ **Đã dừng an toàn** trước khi dừng stack:

```powershell
docker compose stop -t 120
```

Sao lưu `.env`, Compose, state/secrets và mọi volume/bind mount của installation ra ngoài repo. Chỉ tiếp tục khi các nơi ghi dữ liệu đã dừng và backup hoàn tất. Không tạo lại secrets, chép đè `.env`, dùng `down -v` hoặc prune.

## 2. Lấy phiên bản mới

Giữ nhánh đang theo phiên bản cần cập nhật. Chạy từng lệnh; có lỗi thì dừng xử lý trước khi chạy tiếp:

```powershell
git pull --ff-only
git submodule update --init vendor/KAG
```

Không dùng force/reset hoặc `submodule update --remote`: ứng dụng cần đúng phiên bản upstream đã pin.

## 3. Đối chiếu cấu hình và migration

- Bổ sung biến mới từ `.env.example` vào `.env` đang có; giữ các giá trị riêng của installation.
- Giữ Compose project, storage mappings, `KAG_STATE_DIR`, credentials và token. Đổi password trong `.env` không tự đổi password database hoặc tài khoản đã tạo.
- Template cài mới có thể đổi mặc định thư mục token; không chép các đường dẫn mới đó vào installation cũ. Giữ bốn biến `KAG_*_SECRET_FILE` hoặc fallback đang dùng, không tự chuyển state.
- Giữ Builder state, runs, locks và provider state. API/Worker/backend/frontend cần được cập nhật đồng bộ; không lấy cấu hình/target của môi trường thử sang.
- Nếu bản mới đổi database image, schema hoặc Flyway migration, đọc tác động trước khi khởi động. Backend chạy migrations khi startup. Không chạy migration phá dữ liệu nếu chưa có phương án chuyển đổi được duyệt.

Đối chiếu **tên volume và đường mount** với bản sao lưu. Installation có mapping khác hoặc nhiều project dùng chung storage cần kế hoạch chuyển đổi riêng.

```powershell
docker compose config -q
```

Lệnh này kiểm cấu hình Compose, không kiểm tính tương thích của dữ liệu/migration. Không chia sẻ output đầy đủ `compose config` vì có thể chứa secrets.

## 4. Cập nhật ứng dụng

Nếu bản mới đổi schema KAG, hash guard sẽ từ chối release cũ. Thực hiện theo thứ tự dưới; Chat ngừng trả lời trong suốt bước khởi động phiên bản mới và dựng/chuyển graph, cho tới khi graph/release mới sẵn sàng.

1. Hoàn tất backup ở mục 1, giữ image và release cũ để rollback; không ghi đè hoặc xóa graph/release cũ. Nếu đổi storage/database image, chỉ tiếp tục khi phương án chuyển đổi đã được duyệt.
2. Khởi động phiên bản mới trước khi thao tác trên UI:

```powershell
docker compose up -d --build
docker compose ps -a
```

Compose build lại images ứng dụng và cập nhật containers cần thiết, dùng lại storage hiện có. Không cần tự chọn từng service. Đợi đủ 12 services chạy; các service có healthcheck cần chuyển sang `healthy`.

3. Nếu schema KAG đổi, trên UI phiên bản mới: lưu/kiểm Embedding, tạo project/database **rỗng, riêng** trong OpenSPG rồi mở **Chatbot → Đồ thị → + Dựng đồ thị mới**. Chọn **Đồ thị trống**, phạm vi và **Xác nhận dựng**; ứng dụng tự chuẩn bị cấu trúc trước Build. Sau khi dựng/xác minh xong, chọn **Dùng cho Chat → Xác nhận dùng cho Chat**; hệ thống xác minh, đóng gói release (seal) nếu cần rồi mới kích hoạt graph. Không có nút seal riêng. Chờ **Đang dùng cho Chat** và hết thông báo chưa sẵn sàng trước khi kết thúc bảo trì. Nếu schema không đổi, chuyển sang mục 5 để kiểm chức năng đã cấu hình.

Trong suốt bước 2–3, Chat chưa phục vụ; giữ graph/release/image cũ để quay lại khi còn tương thích. Thực hiện theo [hướng dẫn runner](runner.md); không bỏ hoặc nới hash guard. Không chuẩn bị schema mới trên database chứa graph cũ.

Nếu có lỗi, đọc log service liên quan theo [Docker](../docker/README.md#vận-hành); không xóa volume hoặc đổi credentials để thử lại. Builder không tự Resume sau cập nhật.

## 5. Kiểm dữ liệu và chức năng đã cấu hình

1. Mở WebApp ở cổng đang dùng, nhấn **Ctrl+F5** để tải assets mới.
2. Đăng nhập tài khoản cũ; kiểm nội dung, ảnh/tệp, lịch sử chat/thi và cấu hình đã lưu.
3. ADMIN kiểm **Kết nối & chẩn đoán** và **Chatbot → Đồ thị**. Phiên đã dừng phải giữ tiến độ; muốn tiếp tục, kiểm lại nguồn/sẵn sàng rồi tự bấm tiếp tục theo [runner](runner.md#dừng-và-tiếp-tục).
4. Nếu Chat đã được cấu hình, kiểm readiness. Chỉ chủ động gửi câu hỏi thử khi chấp nhận phí provider; `healthy` chưa chứng minh Chat trả lời được.

Thiếu model/target/release ở một installation mới không phải lý do tự tạo graph, bỏ kiểm tra hoặc đổi serving binding. Xem [cấu hình chatbot](../docker/README.md#cấu-hình-chatbot) và [hướng dẫn sử dụng](USER-GUIDE.md).

## Khi cần quay lại bản cũ

Giữ backup và images cũ đến khi kiểm xong. Nếu ứng dụng mới không khởi động an toàn, dừng ghi và dùng lại image/config ứng dụng cũ **chỉ khi còn tương thích với dữ liệu hiện tại**. Hạ source/image không đảo ngược migration.

Phục hồi database cần quy trình riêng: thử backup trên storage biệt lập, đối chiếu đúng source/image/schema rồi mới quyết định chuyển đổi. Không import đè database đang phục vụ và không chạy hai database trên cùng volume. Chi tiết: [Sao lưu và phục hồi](../docker/README.md#sao-lưu).
