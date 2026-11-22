# Kiến trúc LuậtGT

WebApp quản lý tài khoản, nội dung, học thi và lịch sử trò chuyện. KAG dựng đồ thị, tìm nguồn và trả lời theo căn cứ. Xem [cách sử dụng](USER-GUIDE.md) và [cách vận hành Docker](../docker/README.md).

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

React gửi yêu cầu qua Spring Boot đến Worker và Runner. Spring Boot kiểm vai trò ADMIN. Worker kiểm control token và phiên OpenSPG, lưu cấu hình và tiến độ vào các volume của Builder. Luồng dựng tự chuẩn bị schema và index trên đích rỗng trước khi tạo vector. [Hướng dẫn Builder](runner.md)

`PRODUCTION/WRITE` hỗ trợ corpus đã pin, chọn toàn bộ hoặc một phần, dùng model/dimension của phiên. Trước ghi phải khớp nguồn, confirmation, quyền project, identity vật lý và GraphLock; không dùng database serving. `FRESH_SAMPLE` là scope thử biệt lập có giới hạn riêng, không phải giới hạn chung của sản phẩm.

Replay dùng vector trong gói. Builder giữ namespace, số chiều và model của phiên đã xác minh đối với PRODUCTION. SAMPLE dùng contract 3072 chiều. Sau khi dựng, ADMIN vào **Trợ lý → Đồ thị → Dùng cho trợ lý** để kiểm tra và kích hoạt. Publisher xác minh đồ thị và nguồn theo loại release. Worker cấp quyền đọc cho API và chặn dựng hoặc xóa đồ thị đang phục vụ. [Chọn đồ thị phục vụ](runner.md#chọn-graph-phục-vụ-truy-xuấtchat)

## Luồng câu hỏi

```text
React → Spring Boot → KAG /v1/chat/context
  → KAG /v1/query khi cần tra luật → DirectAnswerPipeline
  → KAG API kiểm chứng trích dẫn → Spring Boot lưu kết quả → React
```

1. Spring Boot kiểm quyền và giới hạn truy cập. KAG nhận câu hỏi, tóm tắt và một số lượt gần đây của cùng cuộc trò chuyện để hiểu câu hỏi tiếp nối, hỏi lại hoặc trả lời xã giao. Nếu bước chuẩn bị lỗi, backend chuyển câu gốc sang truy vấn luật.
2. Tuyến truy vấn kiểm định danh release, nguồn, đồ thị và ngày tra cứu. Runtime tạo [`DirectAnswerPipeline`](../kag/legal_solver.py) của LuậtGT-KAG, dùng giao diện pipeline và client mô hình của SDK. Yêu cầu tra tên văn bản hoặc trích nguyên văn đủ điều kiện lấy trực tiếp từ bộ nguồn phục vụ. Nhánh này trả trạng thái thiếu căn cứ nếu tra chính xác không thành công.
3. Với câu hỏi thông thường, pipeline gọi [Retriever](retrieval.md). Retriever dùng Embedding khi cần vector cho câu truy vấn, tìm theo ngữ nghĩa và định danh rồi đọc nguyên văn từ Neo4j. Tùy kết quả và cấu hình, luồng này bổ sung đơn vị cha, cạnh hợp lệ hoặc dẫn chiếu trong cùng điều. Bộ giải lọc phạm vi, hiệu lực và sai lệch nguồn trước khi gọi Chat, rồi kiểm trích dẫn và số liệu trong phản hồi.
4. KAG API đối chiếu trích dẫn với bản nguồn và đọc lại bản ghi từ đồ thị. Spring Boot kiểm lại theo loại nguồn rồi lưu câu trả lời cùng trích dẫn và câu hỏi đã diễn giải, nếu có. Thiếu căn cứ được trả dưới dạng `KAG_ABSTAINED`. Lỗi kỹ thuật được ghi nhận là `UNAVAILABLE` ở WebApp.

`Trích nội dung văn bản: ...` chỉ tra nội dung văn bản xác định, ghi rõ không xác nhận hiệu lực hiện hành.

### Chẩn đoán Chat

`KAG_CHAT_TRACE_QUESTION` mặc định rỗng (tắt). Khi cần đo thời gian, đặt `KAG_CHAT_TRACE_QUESTION=*timings*` trong `.env`, áp dụng lại cấu hình service `kag-api`, rồi đọc `docker compose logs kag-api kag-ingress`. `LEGAL_TRACE` ghi stdout với `request_id`, `stage`, `data`, `elapsed_ms`, `truncated`; chế độ này chỉ giữ `duration_ms`/`outcome`, riêng `request.closed` có `data` rỗng. Mã request được chuyển tới log `KAG_GATEWAY` của HAProxy để đối chiếu thời gian provider; header trace bị bỏ trước khi gửi upstream.

Đặt biến bằng nguyên văn một câu hỏi sẽ bật trace chi tiết cho câu đó: câu hỏi/subquery, nguồn truy xuất, nội dung model và câu trả lời/trích dẫn. Bộ lọc che secrets/token nhưng **không che dữ liệu cá nhân trong câu hỏi**. Mỗi event giới hạn khoảng 1 MiB, mỗi request khoảng 4 MiB; dữ liệu dài bị cắt. Sink không ghi file/volume riêng; log được Docker thu theo cấu hình logging. Sau chẩn đoán, xóa giá trị biến và áp dụng lại cấu hình service.

## Đọc và ghi graph

SDK writer ghi qua OpenSPG Server. Retriever và bộ kiểm chứng đọc Neo4j bằng các truy vấn được cho phép. PRODUCTION đọc qua Worker. SAMPLE Community đọc qua Read Broker. Với cấu hình reader trực tiếp, KAG API cần quyền đọc và kết nối riêng tới Neo4j. Danh tính project/namespace/physical database phải khớp; endpoint hoặc receipt cũ không cấp quyền.

## Hợp đồng HTTP và chính sách tương thích

Nguồn chuẩn: [app.py](../kag/http_api/app.py), [contract.py](../kag/http_api/contract.py), [KagClient.java](../WebApp/backend/src/main/java/vn/luatgt/integration/KagClient.java).

- `POST /v1/chat/context` chuẩn bị ngữ cảnh. `POST /v1/query` nhận `user_id`, `message`, `context_id` rỗng, `schema_contract` và `search_queries` tùy chọn. Phản hồi truy vấn gắn định danh release, snapshot và ngày đối chiếu.
- `graph-chat-v1` hỗ trợ trích dẫn văn bản, điều khoản hoặc biển báo. Mỗi trích dẫn mang bản nguồn `graph-source-v1`. Release legacy yêu cầu `LegalUnit.text` nguyên trường và kiểm xuất bản trong WebApp.
- Câu trả lời theo nguồn dài tối đa 20.000 đơn vị UTF-16, kèm 1–20 trích dẫn. `start=0`, `end` tính theo điểm mã Unicode của nguyên trường.
- `CLARIFY` yêu cầu làm rõ. `KAG_ABSTAINED` có thể mang lý do `no_source`, `out_of_scope` hoặc `expired`. Mã abstain HTTP 503 cũ vẫn được xử lý. Lỗi kỹ thuật lưu `UNAVAILABLE`.
- UI gửi `POST /api/chat/stream?progress=true`. Spring Boot phát SSE `started`, heartbeat và kết quả `done` hoặc `error`. Hai API KAG trả JSON.
- `/v1/health` chỉ liveness. `/v1/operations/sample`, `/v1/pipeline/status`, `/v1/benchmark/datasets` phục vụ inspection, không chạy Builder/benchmark.

Endpoint và secrets: [Docker](../docker/README.md#cấu-hình-chatbot). Control ADMIN, tiến trình và kết quả phiên: [runner](runner.md#dựng-đồ-thị-qua-5-bước). API Builder v3 hỗ trợ `abandon`/xóa dữ liệu với quyền riêng; hai thao tác không tương đương và không tự kích hoạt Chat.

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
