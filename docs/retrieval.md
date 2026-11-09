# Retrieval và helper đánh giá

[`kag/retriever/`](../kag/retriever/) tìm vector và đọc nguyên văn theo exact ID. Chỉ đọc graph, có thể gọi embedding câu hỏi; không gọi Solver/generate answer/writer hoặc đổi project/schema. Frozen slice helper không phải benchmark pháp lý chính thức; framework đầy đủ: [benchmark](../benchmark/README.md).

## Sử dụng

Caller chuẩn bị reader đã xác minh target, embed đúng endpoint/model/dimension và contract; entrypoint dùng SDK phải [bootstrap](runtime.md#bootstrap) trước import.

```python
from kag.retriever.retriever import Retriever

retriever = Retriever(reader, embed, schema_contract, search_k=10)
evidence = retriever.retrieve(question, top_k=10, expand=False)
# Có vector hợp lệ: retriever.retrieve_vector(vector, top_k=10)
```

HTTP SAMPLE cần nguồn/proof/ngân sách theo [Docker](../docker/README.md#cấu-hình-chatbot); không dùng generic Chunk/content retriever.

## Vector và evidence

[`vector_contract.py`](../kag/vector_contract.py) giữ bốn targets: LegalUnit.text, LegalDocument.title, TrafficSign.ten/moTa. Mỗi target cần đúng một ONLINE index dùng cosine. Số chiều do model Embedding đã cấu hình quyết định và phải khớp index; mặc định của cấu hình hiện tại là 3072. Hàm `valid_vector(vector, dimension)` trong `vector_contract.py` nhận dimension làm tham số, không cố định 3072. Query vector hữu hạn, khác zero, score `[0,1]`.

Hydrate theo fully-qualified type + ID, decode outer layer một lần; giữ nguyên ID/Unicode/suffix/text. Evidence gồm source_texts, IDs, score, vector_sources, graph_context. Dedup type + ID, giữ score cao nhất mỗi field; chọn tối đa top_k seeds chung, xếp score giảm rồi type/ID. ANN có thể đổi candidates theo index/runtime.

Expansion mặc định tắt; bật thì một hop, mặc định tối đa 50 relations hợp schema, mỗi cạnh chạm seed. Giữ thứ tự seeds, thêm node dedup theo type/ID; graph-only evidence có `score=null`, `vector_sources=[]`. Không suy các nodes mở rộng là kết quả vector.

## Frozen slice và metrics

[`build_eval_slice`](../kag/retriever/evaluation.py) chỉ chọn câu có gold_unit_ids không rỗng và thuộc exact sample unit IDs. Giữ bytes/thứ tự/metadata nguồn; tạo artifact mới ngoài repo với manifest/hash/identity/lý do loại, không sửa source/gold/sample.

`evaluate(questions, predictions, ks=(1,5,10))` cần đúng một prediction mỗi QID. Ranking unit lấy LegalUnit evidence order, dedup exact ID; document/sign không chiếm rank, TrafficSign.unit_id không tự thành unit được retrieve.

- Hit@k: có ít nhất một gold trong top-k.
- Recall@k: gold unique trong top-k / tổng gold unique.
- MRR: nghịch đảo rank gold đầu; MRR@k chỉ tính nếu rank ≤k.

Macro theo overall/category/source, thiếu metadata giữ unknown. Missing/extra/duplicate prediction hoặc gold sai bị từ chối; slice rỗng BLOCKED/metrics null. Chốt cutoffs/search_k/expansion trước retrieval; không tuning theo gold hoặc sửa gold để bù graph thiếu.
