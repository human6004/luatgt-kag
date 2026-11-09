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

Ba test HTTP đọc cấu hình provider tại `/provider-state` và yêu cầu thư mục thuộc chính user chạy test, không có bit group/other. Trên host thường thư mục này thuộc `root` mode `0700`, nên chạy ngoài container sẽ thấy `closed` hoặc traceback thay vì `idle`:

- `test_security.py::AdmissionTests::test_fresh_shell_import_does_not_load_core_or_registry`
- `test_security.py::AdmissionTests::test_upstream_registry_unchanged_by_shell_lifecycle`
- `test_server.py::PackagedASGITests::test_packaged_read_only_inspection_uses_inspect_scope_and_real_lifespan`

Đây là hành vi fail-closed đúng của [runtime.py](../kag/http_api/runtime.py); chạy các test này trong container hoặc CI có `/provider-state` đúng owner thay vì đổi quyền thư mục trên máy dev.

Audit hook kiểm unlink symlink theo directory entry, không resolve target. Kiểm Docker/API có thể tạo tài khoản/state; cần môi trường thử riêng theo [WebApp](../WebApp/README.md).
