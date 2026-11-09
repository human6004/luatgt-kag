# Kiểm thử Python

Tests chính thức dùng fixtures/doubles, không xác nhận graph/provider live hoặc benchmark pháp lý. Java/frontend: [backend](../WebApp/backend/README.md#chạy), [frontend](../WebApp/frontend/README.md#phát-triển-và-kiểm-thử).

## Chạy suite

**Bước 1:** chuẩn bị [CPython 3.10.16/Linux amd64 và SDK pin](../docs/runtime.md), source read-only, network denied, TMPDIR/fixtures/output ngoài repo. Parser cần `six` trong requirements.

**Bước 2:** từ root chọn suite phù hợp, mỗi suite trong process riêng:

```sh
python -B -m unittest discover -s tests/builder -p "test_*.py" -v
```

Thay `builder` bằng `schema`, `runtime`, `retriever`, `solver`, `runner`, `http_api` hoặc `evaluation`. Không discovery toàn tests trong một process vì fixture names/registry cache trùng.

Kết quả chỉ xác nhận hợp đồng offline của suite, không chạy graph/sample/paid judge thật.

## Phạm vi

- [Builder](builder/README.md): codec/input/plan/polarity/provenance, scoped writer/node barrier, vector retry/checkpoint/chunk fallback.
- [Schema](schema/README.md): parser/model pinned, inheritance/mappings/codec/SAFE_EDGE/runtime requirements.
- Retriever: index/vector/ID/hydration/bounded expansion/ranking; Solver: answer/planning/citations/hiệu lực/xung đột/abstention.
- Runtime: fresh subprocess/import origins/registry/input hashes; Runner: CLI/ledger/outbox/resume/scope/backend/readback.
- HTTP API: auth/admission/query/SSE/release/proof/inspection/broker/budget; Evaluation: dataset/generation/G1/G2/metrics/eligibility/report/CLI.

Runner tests dùng GraphLock cần volume local chung mount `/run/kag-locks` đúng [run_state.py](../kag/run_state.py). Dùng identity synthetic, không database đang phục vụ/spoof mountinfo/bypass shared lock guard. Khóa: [runner](../docs/runner.md#resume-trạng-thái-và-lock).

Audit hook kiểm unlink symlink theo directory entry, không resolve target. Kiểm Docker/API có thể tạo tài khoản/state; cần môi trường thử riêng theo [WebApp](../WebApp/README.md).
