# Chạy benchmark WebApp — 5 bước

Python >=3.10 và `httpx` (đã pin trong requirements dự án). Không cần import KAG,
khởi động Neo4j riêng hay cài thư viện benchmark mới. Trên Windows dùng
`python -X utf8 -B` để in tiếng Việt và không sinh pycache. Các lệnh dưới chạy từ
root repo. Không tự khởi động/chỉnh Docker, không reset lịch sử hay dữ liệu.

## Hợp đồng API đã đối chiếu source

- Login: `POST /api/auth/login`, JSON `{email,password}` → `accessToken`,
  `expiresAt`, `user`. Hoặc cấp JWT có sẵn bằng biến môi trường.
- Kiểm tài khoản: `GET /api/auth/me`, header `Authorization: Bearer <JWT>`.
- Chat: `POST /api/chat/stream`, cùng header, body
  `{message,contextId:"",conversationId:null|UUID}`. SSE `started` chứa id,
  conversationId và PROCESSING; `done`/`error` chứa trạng thái cuối, answer,
  citations, question, createdAt. Heartbeat `: waiting` không phải đáp án.
- Lịch sử: `GET /api/chat` cùng JWT. Chỉ chứa 50 hội thoại gần nhất, nên dùng tài
  khoản thực nghiệm riêng, không thao tác chat song song bằng tài khoản đó.
- Dừng: WebApp có `POST /api/chat/{id}/stop`; runner không tự hủy câu đang chạy.
- Session HTTP stateless JWT; hội thoại lưu server-side theo owner và UUID gốc.
  JWT hết hạn sau khoảng 1 giờ; khi hết phiên, cung cấp token mới cùng tài khoản.
  Chạy mới tạo hội thoại mới. Resume giữ đúng owner và UUID cũ.

Nguồn: ChatController.java, ChatRequest.java, ChatService.java, ChatRepository.java,
AuthController.java, AuthService.java, SecurityConfig.java trong WebApp/backend;
KagClient.java ràng buộc ngày Việt Nam hiện tại. Không thêm endpoint sản phẩm.

## Dữ liệu 100 lượt hỏi

`benchmark/data/benchmark.csv` và `.json` có 13 cột, 100 lượt hỏi: C1–C7, câu chuẩn,
câu noisy, câu verbose, tiền đề sai, 4 hội thoại nhiều lượt gồm hỏi tiếp, đính chính,
đổi chủ đề và câu cần làm rõ; có câu ngoài phạm vi corpus.
Xem [definition](../definition.md). Các ID/quote/URL đã đối chiếu corpus;
đáp án được biên soạn từ nguồn và mẫu cũ, **cần human review pháp lý** trước khi
dùng làm kết luận chất lượng. Đây là bộ phát triển, chưa phải benchmark chính thức.
Ngày tham chiếu cố định 2026-11-19, không tự đổi theo ngày chạy.

Phân bố category: C1=20, C2=15, C3=10, C4=15, C5=20, C6=10, C7=10.
Expression: standard=50, noisy=25, verbose=25. Các kiểu diễn đạt được gán cho
các nhiệm vụ khác nhau; không nhân bản một tình huống thành ba bản chỉ đổi cách viết.
Content tags: false_premise=10, underspecified=10 (nhãn có thể giao với multi_request).
Reasoning: direct=40, single_step=30, multi_step=30. Phân bố là lựa chọn thiết kế,
không chứng minh độ khó thực tế hoặc số bước model đã thực hiện.
Các câu so sánh một quy tắc trực tiếp dùng single_step; multi_step cần nối các
vai trò/căn cứ để đi tới kết luận. Category và reasoning là hai trục khác nhau.
Đọc điểm theo từng nhóm cùng số đúng/tổng mẫu; 10 câu vẫn là nhóm nhỏ.
Không diễn giải chênh lệch giữa noisy/verbose và standard như tác động thuần của
cách viết vì các nhóm hiện có nội dung khác nhau.

## Cấu hình

`benchmark/runner/config.json` chỉ có cấu hình công khai. Base URL mặc định là
WebApp local 8081; thay bằng địa chỉ triển khai thực tế. Timeout 180s, nghỉ 3.1s
giữa câu để dưới giới hạn chat 20 lượt/phút; retries=2 chỉ cho 429 bị từ chối
trước khi lưu chat. Tăng backoff hoặc giảm tốc độ khi dùng tài khoản chung.
Ngân sách được kiểm sau mỗi dòng SSE và trước mỗi retry. Socket không có dữ liệu
trong tối đa 10s được ngắt (WebApp gửi heartbeat mỗi giây); timeout mỗi attempt
được thu nhỏ theo ngân sách còn lại. Với I/O đồng bộ, phát hiện hết ngân sách có
thể trễ tối đa một cửa sổ read đang chờ, không phải deadline thời gian thực cứng.
`dataset_version` là nhãn do người biên soạn khai báo; content ID của snapshot được
ghi tự động. `system_version`/`model_version` để null nếu không biết; không suy đoán.
Runner ghi git revision và cờ local changes; các phiên bản model do config cung cấp
là thông tin khai báo, không được coi là đã xác minh từ API.

PowerShell, lựa chọn một cách xác thực (không ghi credentials vào config/CLI/file):

```powershell
$env:BENCHMARK_TOKEN = Read-Host 'JWT của tài khoản benchmark' -MaskInput
# Hoặc: email và mật khẩu tài khoản đã có, đăng nhập qua endpoint hiện tại.
$env:BENCHMARK_EMAIL = Read-Host 'Email benchmark'
$env:BENCHMARK_PASSWORD = Read-Host 'Mật khẩu benchmark' -MaskInput
```

JWT được ưu tiên nếu có cả hai. Không đăng ký tài khoản tự động. Không ghi token,
password vào artifact; auth response không lưu, secret đã biết được redact trong
chat response/metadata. Kết quả chứa câu hỏi và phản hồi đầy đủ nên chỉ dùng dữ
liệu thực nghiệm phù hợp, không đưa nội dung riêng tư ngoài phạm vi vào pilot.

## Chạy từng bước

### 1. Validate (offline, không ghi output)

```powershell
python -X utf8 -B benchmark/runner/01_validate.py --compare benchmark/data/benchmark.json
```

Kiểm 13 cột, miền nhãn, qid trùng, dữ liệu thiếu, lượt hội thoại liền nhau bắt đầu
từ 1, source IDs, URL và quote nguyên văn. Không chứng minh quan hệ graph có thật,
không tự sửa gold và không tự chốt đáp án đúng về pháp lý.

### 2. Chạy thử / chạy toàn bộ

```powershell
python -X utf8 -B benchmark/runner/02_run.py --limit 3
python -X utf8 -B benchmark/runner/02_run.py
```

`--dataset` nhận CSV hoặc JSON. Limit lấy prefix và mở rộng đủ hội thoại cuối,
không cắt mất các lượt cần thiết. Mỗi lần chạy mới có UUID run_id và cặp
`ketqua_YYYYMMDD_HHMMSS.csv`, `checkpoint_YYYYMMDD_HHMMSS.json` trong
`benchmark/output`. Timestamp UTC+07:00. Trùng tên trong cùng giây bị từ chối,
không ghi đè kết quả khác. `--output-dir` cho phép đổi nơi lưu (kiểm thử tạm dùng
workspace ngoài repo). Checkpoint chứa snapshot dataset/config và mọi event đã
nhận; CSV được cập nhật sau mỗi checkpoint. Không đưa gold vào request chat.

Ngày khác ngày hiện tại: ghi DATE_UNSUPPORTED, không gọi API. Khi muốn khảo sát
luật hiện hành ngày mới, biên soạn/review phiên bản dataset tương ứng rồi đổi
dataset_version; không đổi ngày hàng loạt mà không xem lại đáp án.

### Tiếp tục sau gián đoạn

```powershell
python -X utf8 -B benchmark/runner/02_run.py --resume benchmark/output/checkpoint_YYYYMMDD_HHMMSS.json
```

Giữ dataset/config/tài khoản như cũ, không truyền limit mới. Các lượt đã ghi kết
quả cuối không gọi lại. Có started ID thì đọc history để khôi phục đúng message;
chưa terminal thì dừng chờ, không gửi lượt tiếp. Nếu bị ngắt sau POST nhưng trước
started ID, API không có idempotency key hoặc lookup theo client request ID:
runner dừng báo outcome chưa xác định, không retry mù. Đối soát trên tài khoản
thực nghiệm; nếu cần chạy mới thì run_id mới và giữ nguyên run cũ. Không tự gắn
một câu cùng text trong history vào qid vì có thể là lượt khác.

HTTP 429 có thể retry với backoff; lỗi 5xx, timeout, mất stream không tự POST lại
vì có thể server đã lưu lượt hỏi. Không thể đảm bảo exactly-once ở khe POST→started
chỉ bằng client; runner chọn dừng bảo toàn kết quả. CSV bị ngắt lúc ghi có thể dựng
lại từ checkpoint khi resume. Checkpoint chưa lưu được phải xử lý lỗi đĩa trước
khi tiếp tục. Không chạy đồng thời hai process trên cùng checkpoint.

### 3. Đánh giá (offline)

```powershell
python -X utf8 -B benchmark/runner/03_evaluate.py --results benchmark/output/ketqua_YYYYMMDD_HHMMSS.csv
```

Xuất `evaluate_YYYYMMDD_HHMMSS.csv` và phiếu
`evaluate_YYYYMMDD_HHMMSS_review_template.json`. Nội dung chưa có review ghi N/A;
rule/source-comparison vẫn tính được. Điền phiếu theo rubric definition.md, lưu
thành file review riêng trong output rồi chạy:

```powershell
python -X utf8 -B benchmark/runner/03_evaluate.py --results benchmark/output/ketqua_YYYYMMDD_HHMMSS.csv --reviews benchmark/output/human_review.json
```

Chỉ chấm lại trên kết quả đã lưu, không gọi chatbot/judge provider. Phiếu gắn
run_id/dataset_id, có reviewer/rationale. Điểm không chắc giữ null để review lại.
Kết quả đánh giá mới luôn có tên mới, không sửa bản trước. Nếu chạy hai lần trong
cùng giây thì đợi sang giây mới. Phải giữ checkpoint cạnh file ketqua gốc để
đối chiếu snapshot, không chỉ copy riêng CSV.

### 4. Tổng hợp (offline)

```powershell
python -X utf8 -B benchmark/runner/04_aggregate.py --evaluation benchmark/output/evaluate_YYYYMMDD_HHMMSS.csv
```

Xuất `aggregate_YYYYMMDD_HHMMSS.json`: overall, category, case_group, reasoning,
expected behavior, từng nhãn expression/content và conversation_type; denominator,
N/A coverage/reasons và P50/P95. Hội thoại vẫn được phân tích theo loại lượt;
không xuất Multi-turn Success Rate. Không suy ranking từ citations; đánh giá
Retriever riêng theo definition.md, không nằm trong bước chấm chat 03–05.

### 5. Báo cáo (offline)

```powershell
python -X utf8 -B benchmark/runner/05_report.py --aggregate benchmark/output/aggregate_YYYYMMDD_HHMMSS.json
```

Xuất `report_YYYYMMDD_HHMMSS.md`, gồm giá trị và lý do N/A, không tự đặt PASS.
Mỗi bước 3–5 có thể chạy lại độc lập từ artifact đầu vào. Công thức, phạm vi mẫu
và chiều đánh giá từng metric nằm trong definition.md.
