# Đánh giá KAG

Implementation: [`kag/evaluation/`](../kag/evaluation/). Inputs/output thực chạy nằm ngoài repo. Đánh giá không phải bước startup.

## Dataset

- `PROVISIONAL`: phát triển, giữ nhãn thiếu/chưa chắc.
- `FROZEN`: version/bytes/manifest hashes bất biến; freeze CLI luôn nonofficial.
- `official_benchmark`: phải chỉ định tường minh trong manifest hợp lệ; synthetic/SAMPLE/frozen không tự thành official.

Benchmark chính thức chưa hoàn thành; `COMPLETE` chỉ ghi nhận mọi câu, report giữ `PAPER_ELIGIBLE=NO`. Không tự bổ sung gold hoặc đưa eval vào retrieval corpus. Validator/lifecycle: [dataset.py](../kag/evaluation/dataset.py), chuyển dữ liệu cũ: [legacy.py](../kag/evaluation/legacy.py).

## Tạo câu hỏi từ nguồn

[generation.py](../kag/evaluation/generation.py) lấy gold từ source span có hash, model không tạo gold. Catalog `h1-source-catalog-1.0`; evidence offsets dùng Unicode code points. Positive EXTRACT_ONLY; negative ABSTAIN/gold rỗng, rationale giới hạn phạm vi; multi-hop cần hai Điều độc lập/rationale. Thiếu nguồn ghi deferred, không giả gold; `as_of` không tự thành ngày hiệu lực.

**Bước 1:** chuẩn bị catalog, drafts, config theo generation.py, output mới ngoài repo.

**Bước 2:** từ root trong [runtime](../docs/runtime.md), chọn lệnh phù hợp; đường dẫn là ví dụ:

```sh
python -B -m kag.evaluation generate --catalog /external/catalog.json --drafts /external/drafts.json --config /external/config.json --output-dir /runs/new-dataset
python -B -m kag.evaluation validate-generated /runs/new-dataset/eval_questions.jsonl --catalog /external/catalog.json --generation-manifest /runs/new-dataset/generation-manifest.json
```

Kết quả: draft/generation manifest và kiểm cấu trúc/nguồn, chưa thay review pháp lý.

**Bước 3:** review rồi freeze:

```sh
python -B -m kag.evaluation freeze /runs/new-dataset/eval_questions.jsonl --output-root /runs/reviewed --dataset-version reviewed-v1 --review /external/human-review.json
```

Receipt cần dataset_hash/reviewer/reviewed_at UTC Z/approved_qids phủ đúng dataset. CLI kiểm hash/coverage, không xác thực reviewer. Generated dataset thiếu receipt bị chặn; output mới không ghi đè source/gold.

Dataset offline còn có `validate` và `import-legacy`; xem `python -B -m kag.evaluation --help`.

## G1/G2 và kết quả

[evaluate.py](../kag/evaluation/evaluate.py) có `evaluate_g1`, `evaluate_g2`, `aevaluate_g2`: caller cấp retriever/pipeline/protocol/runtime/quyền execution. G1 gọi retrieve, G2 gọi public answer/aanswer; QID/gold/category không đi vào inference. CLI chưa chạy benchmark live.

Policy 1.0 giữ metrics hiện hữu; opt-in `EvaluationProtocol(metric_policy_version="1.1")` thêm source-span/ranking/macro/accounting. Metric thiếu bằng chứng giữ null/lý do; không tự đặt composite/PASS threshold hoặc coi judge/trace thiếu là correctness.

[report.py](../kag/evaluation/report.py) ghi snapshots/manifest/metrics/hashes ngoài repo, không secrets. Frozen/complete không cấp quyền benchmark, production readiness hoặc điều kiện công bố khoa học. Kiểm framework: [tests](../tests/README.md).
