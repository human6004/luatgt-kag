# Backend LuậtGT

Spring Boot **3.5.16**, Java **21**; monolith MVC với một MySQL nghiệp vụ. Controller kiểm DTO/gọi service; service giữ nghiệp vụ/giao dịch; repository chỉ truy cập dữ liệu. Không trả entity trực tiếp. Tuân thủ [rule.md](../rule.md).

## Cấu trúc

[`src/main/java/vn/luatgt/`](src/main/java/vn/luatgt/) gồm `controller`, `dto`, `service`, `repository`, `model`, `integration`, `config`, `exception`. [`src/main/resources/`](src/main/resources/) giữ cấu hình và Flyway migrations.

## Chạy

Cài stack theo [INSTALL](../../docs/INSTALL.md); API mặc định `http://127.0.0.1:8080/api`, health `/actuator/health`.

**Bước 1 — Phát triển trên host:** nếu chạy ngoài Docker, dùng Java 21/Maven và MySQL/Redis/MinIO riêng. Đặt biến theo [application.yml](src/main/resources/application.yml), gồm `DB_PASSWORD`, `REDIS_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `MINIO_USER`, `MINIO_PASSWORD`; đổi `DB_URL`, `DB_USER`, `MINIO_URL` nếu cần. Redis URL phải chứa mật khẩu; Java không tự đọc `.env`.

Mọi lệnh Maven trong hướng dẫn này chạy tại `WebApp/backend/` (nơi có `pom.xml`):

```powershell
mvn spring-boot:run
```

Kết quả: backend khởi động. ADMIN bootstrap chỉ tạo email chưa có, không đặt lại mật khẩu/nâng USER thành ADMIN; tự đăng ký luôn là USER.

**Bước 2 — Chạy bằng Docker sau khi sửa backend:** bảo đảm MySQL, Redis và MinIO đang chạy theo hướng dẫn [WebApp khi chưa chạy KAG](../README.md#webapp-khi-chưa-chạy-kag). Từ thư mục gốc repository, build và cập nhật riêng backend:

```powershell
docker compose build backend
docker compose up -d --no-deps backend
```

Compose dùng cấu hình trong `.env`; `--no-deps` không kéo các service KAG lên. Các volume dữ liệu được giữ nguyên. Backend chạy Flyway khi khởi động, vì vậy chỉ trỏ vào database dành cho môi trường phát triển. Nếu backend chưa chạy, xem log bằng `docker compose logs --tail 100 backend` và che secrets trước khi chia sẻ.

Compose mặc định dùng `ADMIN_EMAIL=admin@luatgt.local`. Bootstrap chỉ tạo tài khoản nếu email chưa tồn tại; nếu email đã thuộc tài khoản không phải `ADMIN`, backend dừng với lỗi. Nếu tài khoản `ADMIN` đã tồn tại, bootstrap không đổi mật khẩu của tài khoản đó. `ADMIN_PASSWORD` phải dài ít nhất 12 ký tự và tối đa 72 byte UTF-8.

**Bước 3 — Kiểm thử:** quay lại `WebApp/backend/` trước mọi lệnh Maven. Nếu vừa chạy Bước 2 ở root repository:

```powershell
Set-Location WebApp/backend
mvn verify
```

Mặc định dùng H2 chế độ MySQL và mock dịch vụ ngoài. Muốn kiểm MySQL thật, đặt `TEST_DB_URL`, `TEST_DB_USER`, `TEST_DB_PASSWORD` cho **database test riêng, rỗng** trước lệnh; xóa biến sau khi chạy. Tests/Flyway ghi bảng, tài khoản và nội dung, không dùng database đang phục vụ.

## API và dữ liệu

Tiền tố `/api`. Ngoài đăng ký/đăng nhập/health, API cần Bearer JWT; hết hạn một giờ, logout/khóa tài khoản thu hồi token. Endpoint/DTO chuẩn nằm trong [controller](src/main/java/vn/luatgt/controller/) và [dto](src/main/java/vn/luatgt/dto/), không duy trì danh sách route thứ hai ở đây.

Ba vai trò: `ADMIN` toàn quyền; `POLICE` quản lý nội dung luật, câu hỏi, biển báo và xử lý nhật ký chat; `USER` dùng các chức năng cá nhân. API tài khoản, hạ tầng và cấu hình KAG chỉ dành cho `ADMIN`. Đăng ký luôn tạo `USER`; admin gán `USER`/`POLICE` qua `PATCH /api/admin/users/{id}` với `{"role":"POLICE"}` hoặc `{"role":"USER"}`; trường `enabled` vẫn dùng để khóa/mở tài khoản. Đổi quyền thu hồi token cũ, cần đăng nhập lại. `ADMIN` giữ cơ chế bootstrap và không đổi/khóa qua API này. Migration V4 mở rộng vai trò, giữ nguyên tài khoản hiện có.

- Lịch sử chat cá nhân chỉ trả cho chủ tài khoản. Danh sách, xuất CSV và số liệu chat quản trị chỉ gồm phản hồi `WRONG`, `NO_BASIS`, `OUTDATED`; không đưa chat chưa báo cáo hoặc `HELPFUL` vào hàng chờ. Báo cáo đã xử lý vẫn xem được trong danh sách báo cáo; đổi phản hồi sang `HELPFUL` sẽ ngừng hiển thị cho ADMIN/POLICE. Thao tác xử lý không được truy cập chat ngoài phạm vi này.
- UUID là khóa quản trị; `externalId` giữ ID nguồn. Import nhận tên nguồn hoặc alias contract, từ chối alias/ID xung đột và kiểu sai. Preview không ghi; confirm kiểm lại và ghi toàn bộ hoặc rollback. Version ngăn sửa đè.
- LegalUnit thuộc đúng văn bản/cây cha; chặn cha thiếu/khác văn bản và chu trình. Xuất bản cần kiểm duyệt và văn bản nguồn đã xuất bản; câu hỏi còn kiểm đáp án/điểm liệt/ảnh, biển báo kiểm nguồn/ảnh, mức phạt kiểm căn cứ và số nguyên không âm.
- Flyway V5 thêm schema ngân hàng/bộ/chủ đề, revision và option bất biến, cấu hình đề, lượt thi/luyện và catalog biển báo. V6 chuyển câu đã xuất bản và catalog biển báo hiện có; giữ nguyên `content`, `exams`, `study_attempts` và lịch sử cũ. `accounts` tiếp tục là tài khoản dùng chung (APP_USER trên ERD). Ngày ban hành chưa biết được để NULL; ngân hàng cũ mang nhãn LEGACY, giữ chính sách B trước nâng cấp. Không tự nhập các tệp 250/600 câu.
- Nhập câu hỏi nhận `questionSetId`, giữ mã nguồn trong `sourceExternalId` và tách định danh quản trị theo bộ. ZIP ảnh câu hỏi nhận cùng `questionSetId`. Cấu hình bộ/quy tắc ở `/api/admin/questions/sets` và `/api/admin/questions/rules`, cho ADMIN/POLICE; USER đọc `/api/question-sets`, `/api/exam-rules`. Quy tắc có khoảng hiệu lực không chồng trong cùng bộ/hạng.
- Thi mới lưu bằng `exam_attempt`, `attempt_question`, `attempt_answer`; chấm theo đúng revision, option, ảnh và rule đã phát. Luyện lưu `study_attempt`, API tiến độ hỗ trợ `questionSetId`. Hiện hỗ trợ câu single-choice. Foreign key ghép chặn option sai revision và câu sai bộ; các cột khóa ghép bổ sung phục vụ ràng buộc thực thi trên MySQL. Giữ kiểm quyền sở hữu; không dùng AI chấm. Quy tắc luyện tập: [USER-GUIDE](../../docs/USER-GUIDE.md#user--ôn-và-thi-thử).
- MinIO: PNG/JPEG ≤5 MB, 4096×4096; PDF ≤20 MB; ZIP ≤20 MB nén/50 MB giải nén/1.000 mục. Không nhận SVG/WebP. ZIP câu hỏi ghép `externalId`, biển báo ghép `ma_bien`; mã nhiều biến thể trả unmatched để xử lý thủ công.

## Schema và KAG

Maven đóng gói [schema_contract.json](../../kag/schema/schema_contract.json) và [VietRoadTraffic.schema](../../kag/schema/VietRoadTraffic.schema) qua cấu hình resource trong pom; backend kiểm schema hash. Không duy trì schema Java riêng; đổi contract/schema cần build lại backend.

[KagClient](src/main/java/vn/luatgt/integration/KagClient.java) gọi Python query/inspection; query, inspection, Builder dùng token files riêng. Browser giữ JWT WebApp và phiên đăng nhập OpenSPG native trên cùng hostname. Java chỉ chuyển cookie OpenSPG đúng tên tới Worker khi đọc catalog/chọn target/preflight/Build/Resume; không lưu session hoặc chuyển JWT WebApp cho OpenSPG. Cấu hình endpoint/release/snapshot/mạng theo [Docker](../../docker/README.md#cấu-hình-chatbot); Compose không publish KAG cho Java host.

Hợp đồng request/citations/SSE và phân biệt `KAG_ABSTAINED`/`UNAVAILABLE` nằm tại [kiến trúc](../../docs/architecture.md#hợp-đồng-http-và-chính-sách-tương-thích). Không bỏ validation nguồn/publication để ép success.

Builder catalog/config/status/structure/selection/preflight/Build/Stop/Resume/Abandon/clear gọi Worker bằng control token, chịu quyền ADMIN/OpenSPG và kiểm nguồn/identity/lock. UI chọn project theo ID; preview chỉ đọc, apply cần xác nhận và revision hiện hành. Bỏ phiên giữ graph; xóa dữ liệu cần quyền riêng theo project/physical database, không áp dụng cho serving hoặc database dùng chung. Backend không điều khiển Docker hoặc chạy benchmark. [Runner](../../docs/runner.md#dựng-đồ-thị-qua-5-bước) giữ hướng dẫn; Builder hoàn tất không kích hoạt Chat.
