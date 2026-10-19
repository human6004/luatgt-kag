# Kiến trúc LuậtGT

WebApp quản lý nghiệp vụ, nội dung kiểm duyệt và lịch sử. KAG xây graph, truy hồi nguồn và trả lời theo căn cứ. [Docker](../docker/README.md) mô tả services, mạng, cổng và storage; [USER-GUIDE](USER-GUIDE.md) giữ phạm vi chức năng thật/Demo.

## Thành phần

- React/TypeScript → Spring Boot monolith MVC: tài khoản, nội dung, học/thi, chat/phản hồi.
- Python KAG: Builder, Retriever, Solver, Evaluation và HTTP API, tái sử dụng SDK upstream.
- OpenSPG Server: project/schema và ghi graph; Neo4j: node/cạnh/vector/index.
- MySQL nghiệp vụ và MySQL OpenSPG riêng; Redis giới hạn truy cập; MinIO WebApp/OpenSPG riêng; HAProxy kiểm soát egress provider.

Schema/contract Python là nguồn chuẩn, Java đóng gói cùng file; không tạo schema riêng. Xuất bản WebApp không tự đồng bộ graph. Mô hình/codec: [domain](domain_model.md), [schema](schema.md).

## Xây dựng graph

```text
Nguồn + schema + quan hệ → kiểm input/plan → vectorize hoặc replay
  → ghi node → đọc lại node → ghi cạnh → verify graph/vector
```

Đường điều khiển: React → Spring Boot kiểm ADMIN → Worker xác thực control token/phiên OpenSPG → Runner. Worker lưu cấu hình/kế hoạch trong Builder state, tiến độ trong run volume. Chuẩn bị schema/index là thao tác preview/apply riêng trước Build, không gọi model. [Runner](runner.md) giữ hướng dẫn thao tác.

`PRODUCTION/WRITE` hỗ trợ corpus đã pin, chọn toàn bộ hoặc một phần, dùng model/dimension của phiên. Trước ghi phải khớp nguồn, confirmation, quyền project, identity vật lý và GraphLock; không dùng database serving. `FRESH_SAMPLE` là scope thử biệt lập có giới hạn riêng, không phải giới hạn chung của sản phẩm.

Vectorizer không tự chuyển từ replay sang provider khi thiếu vector. Builder dùng dimension theo model đã kiểm. Release PRODUCTION giữ namespace/dimension/model của phiên đã xác minh; SAMPLE giữ contract 3072 chiều. Dựng xong không tự kích hoạt Chat: ADMIN chọn phiên, xem trước và xác nhận tại Đồ thị tri thức; publisher kiểm graph và nguồn WebApp trước khi đổi lựa chọn. Worker cấp phép đọc cố định cho API; graph đang phục vụ được chặn Build/xóa. Điều kiện: [chọn graph phục vụ](runner.md#chọn-graph-phục-vụ-truy-xuấtchat), [backend identity](backend-identity.md#writer-và-lock), [publisher](../docker/README.md#publisher-nâng-cao).

## Luồng câu hỏi

```text
React → Spring Boot (auth/rate limit/lịch sử) → Python HTTP API
  → OpenSPG Planner → Retriever → Read Broker → Neo4j
  → Deduce → SafeLegalGenerator → Spring Boot kiểm nguồn → React
```

1. API kiểm release/snapshot, publication, schema, target, ngày truy vấn và ngân sách provider. Browser chỉ giữ JWT; token KAG là secrets giữa dịch vụ.
2. Planner/pipeline lặp upstream điều phối truy hồi và suy luận. Retriever tìm vector, đọc nguyên văn theo ID; mở rộng một hop có giới hạn, mặc định tắt.
3. Deduce kiểm căn cứ, điều kiện áp dụng, hiệu lực và xung đột. SafeLegalGenerator kiểm source/span/liên kết yêu cầu, ghép trích đoạn đã xác minh; không gọi thêm model để viết tự do.
4. Spring Boot kiểm document/unit đã xuất bản, điều kiện hiệu lực và quote khớp rồi lưu. Thiếu căn cứ thì abstain; lỗi dịch vụ thì unavailable.

`Trích nội dung văn bản: ...` chỉ tra nội dung văn bản xác định, ghi rõ không xác nhận hiệu lực hiện hành.

## Đọc và ghi graph

SDK writer ghi qua OpenSPG Server. Retriever/verifier đọc Neo4j bằng truy vấn được cho phép. SAMPLE Community dùng `BrokerRetrievalClient` gửi operation DTO tới Read Broker; API không giữ credential DB ở đường này. Đường reader trực tiếp cần cấu hình/mạng riêng. Danh tính project/namespace/physical database phải khớp; endpoint hoặc receipt cũ không cấp quyền.

## Hợp đồng HTTP và chính sách tương thích

Nguồn chuẩn: [app.py](../kag/http_api/app.py), [contract.py](../kag/http_api/contract.py), [KagClient.java](../WebApp/backend/src/main/java/vn/luatgt/integration/KagClient.java).

- Query: `{user_id,message,context_id,schema_contract}`; `context_id` rỗng, headers bind release/snapshot/`as_of`. Lịch sử không tự thành ngữ cảnh hội thoại.
- Native Solver hỗ trợ document/unit/sign; success HTTP v1 chỉ hỗ trợ **`LegalUnit.text` nguyên trường**, đủ publication. Không cắt nguồn/đổi ID để ép vừa contract; kết quả không biểu diễn được trả `V1_RESULT_UNREPRESENTABLE`.
- `answer` ≤20.000 UTF-16 units; 1–20 citations gồm `doc_id,unit_id,sign_id,evidence_id,field,start,end,quote`. `sign_id=null`, `field=text`, `start=0`, `end` tính Unicode code points.
- Abstention hợp lệ: HTTP 503 `KAG_ABSTAINED`, `native_state=abstained`; Java kiểm cấu trúc/headers/request identity rồi lưu `KAG_ABSTAINED`. Lỗi khác lưu `UNAVAILABLE`.
- Python SSE phát terminal `done` sau validation; Java tương thích `delta/done`. UI hiện dùng REST.
- `/v1/health` chỉ liveness. `/v1/operations/sample`, `/v1/pipeline/status`, `/v1/benchmark/datasets` phục vụ inspection, không chạy Builder/benchmark.

Endpoint và secrets: [Docker](../docker/README.md#cấu-hình-chatbot). Control ADMIN, tiến trình và kết quả phiên: [runner](runner.md#dựng-đồ-thị-qua-5-bước). Builder v3 hỗ trợ Bỏ phiên/Xóa dữ liệu với quyền riêng; hai thao tác không tương đương và không tự kích hoạt Chat.

## Evaluation Framework

[`kag/evaluation/`](../kag/evaluation/) nhận runtime từ caller: G1 gọi Retriever; G2 gọi `answer()/aanswer()`. Gold/QID không đi vào inference; model không tự tạo gold. Metric thiếu điều kiện giữ `null` kèm lý do. Dataset frozen không tự thành benchmark chính thức; bộ câu hỏi chính thức chưa hoàn thành. Lifecycle/lệnh/quyền đánh giá: [benchmark](../benchmark/README.md).

## Bản đồ mã nguồn

- `kag/builder/`: inputs/plan/codec/vectorizer/writer.
- `kag/runner.py`, `run_state.py`, `verify.py`: điều phối/state/lock/readback.
- `kag/retriever/`: vector search/hydration/expansion; `legal_solver.py`, `legal_prompts.py`: public answer và kiểm căn cứ.
- `kag/http_api/`: auth/serving/broker/ngân sách/inspection; `kag/evaluation/`: dataset/generation/metrics/report.
- `WebApp/`: nghiệp vụ và nội dung xuất bản độc lập với graph.

Local `kag` ghép namespace upstream; không đổi thứ tự import hoặc bỏ `__init__.py` để né bootstrap. Quy tắc: [runtime](runtime.md).

## Entrypoints và lệnh ổn định

Từ root trong runtime chuẩn: `python -B -m kag --help`, `python -B -m kag.evaluation --help`. Runner có `run/resume/verify`; evaluation CLI xử lý dataset offline. HTTP server: `python -B -m kag.http_api.server` với cấu hình phục vụ phù hợp.

Library: `Retriever.retrieve`, `build_pipeline(retriever, llm)`, `answer(question, pipeline=..., as_of=...)`, `aanswer(...)`. Startup không tự build graph/chạy benchmark.
