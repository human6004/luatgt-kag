# Kiểm thử Python

Tests chính thức dùng fixtures/doubles, không xác nhận graph/provider live hoặc benchmark pháp lý. Java/frontend: [backend](../WebApp/backend/README.md#chạy), [frontend](../WebApp/frontend/README.md#phát-triển-và-kiểm-thử).

## Chạy suite

**Bước 1 — Runtime:** chuẩn bị [CPython 3.10.16/Linux amd64 và SDK pin](../docs/runtime.md). Windows dùng Linux containers. Từ root checkout có submodule, build image dev (cần mạng):

```powershell
docker build --platform linux/amd64 -f docker/kag-runtime/Dockerfile -t vietroadtraffic-kag-runtime:local .
```

Dockerfile cài cả `requirements.txt` và `requirements-http-api.txt`, rồi chạy `pip check`. File HTTP chỉ dùng `-c requirements.txt` để ràng buộc phiên bản, không thay cho cài runtime; `six` nằm trong requirements runtime. Nếu dùng venv riêng trên Linux amd64 với đúng Python 3.10.16, từ root checkout:

```sh
python3.10 -m venv ../luatgt-test-venv
../luatgt-test-venv/bin/python -m pip install -r requirements.txt -r requirements-http-api.txt
../luatgt-test-venv/bin/python -m pip check
```

Venv không tự tạo mount GraphLock hoặc `/provider-state`; dùng recipe container dưới cho các suite cần chúng.

**Bước 2 — Volume khóa test riêng:** cả suite Builder và Runner cần named volume local mount tại `/run/kag-locks`, ghi được bởi user chạy test. [Writer fixture](builder/test_writer_adapter.py#L228) lấy GraphLock thật; [run_state.py](../kag/run_state.py#L91) kiểm mountinfo, tên volume và filesystem ext4/xfs/btrfs. Tạo thư mục thường không đủ. Không spoof mountinfo hoặc bỏ guard.

PowerShell, vẫn tại root repo; dùng tên mới mỗi phiên để không đụng khóa installation đang phục vụ:

```powershell
$testLockVolume = "luatgt-test-$([guid]::NewGuid().ToString('N'))_kag-builder-graph-locks"
docker volume create --driver local $testLockVolume
docker run --rm --platform linux/amd64 --network none --user 0:0 --entrypoint sh --mount "type=volume,source=$testLockVolume,target=/run/kag-locks" vietroadtraffic-kag-runtime:local -c "chown 10001:10001 /run/kag-locks && chmod 700 /run/kag-locks"
```

Dừng nếu lệnh nào lỗi. Chỉ đổi owner volume test mới này; không dùng tên volume sản phẩm. Các process test cùng phiên dùng cùng volume. Đổi UID/GID thì phải đổi cả lệnh chuẩn bị, `--user` và tùy chọn tmpfs phía dưới.

**Bước 3 — Chạy từng suite:** source bind chỉ đọc, TMPDIR/fixtures/output trong `/tmp` của container, ngoài repo. `/provider-state` là tmpfs mới mỗi container, owner UID/GID 10001, mode 0700; không mount provider state sản phẩm.

“Network denied” nghĩa là chặn egress, vẫn cho phép loopback. `--network none` giữ loopback; các tests broker và backend mở HTTP server thật trên `127.0.0.1`. Không dùng chính sách cấm mọi socket.

```powershell
$testSuite = "builder"
docker run --rm --platform linux/amd64 --network none --user 10001:10001 --env HOME=/tmp --env TMPDIR=/tmp --env KAG_GRAPH_LOCK_VOLUME=$testLockVolume --mount "type=bind,source=$($PWD.Path),target=/workspace,readonly" --mount "type=volume,source=$testLockVolume,target=/run/kag-locks" --tmpfs /tmp:rw,mode=1777 --tmpfs /provider-state:rw,uid=10001,gid=10001,mode=0700 vietroadtraffic-kag-runtime:local -m unittest discover -s "tests/$testSuite" -p "test_*.py" -v
```

Thay `builder` bằng `schema`, `runtime`, `retriever`, `solver`, `runner`, `http_api` hoặc `evaluation` rồi chạy lại lệnh Docker. Mỗi suite một process/container riêng; không discovery toàn tests trong một process vì fixture names/registry cache trùng. ENTRYPOINT của image đã có `python -B`. Nếu lưu log, chuyển hướng vào workspace ngoài repo. Container xóa tmpfs khi kết thúc; không dùng thư mục repo làm output.

Kết quả chỉ xác nhận hợp đồng offline của suite, không chạy graph/sample/paid judge thật. Recipe trên chưa thay thế kiểm trên môi trường của người nhận.

## Phạm vi

- [Builder](builder/README.md): codec/input/plan/polarity/provenance, scoped writer/node barrier, vector retry/checkpoint/chunk fallback.
- [Schema](schema/README.md): parser/model pinned, inheritance/mappings/codec/SAFE_EDGE/runtime requirements.
- Retriever: index/vector/ID/hydration/bounded expansion/ranking; Solver: answer/planning/citations/hiệu lực/xung đột/abstention.
- Runtime: fresh subprocess/import origins/registry/input hashes; Runner: CLI/ledger/outbox/resume/scope/backend/readback.
- HTTP API: auth/admission/query/SSE/release/proof/inspection/broker/budget; Evaluation: dataset/generation/G1/G2/metrics/eligibility/report/CLI.

Builder và Runner tests dùng GraphLock cần volume test local chung mount `/run/kag-locks` đúng [run_state.py](../kag/run_state.py). Dùng identity synthetic, không database đang phục vụ/spoof mountinfo/bypass shared lock guard. Khóa: [runner](../docs/runner.md#resume-trạng-thái-và-lock).

Ba test HTTP đọc cấu hình provider tại `/provider-state` và yêu cầu thư mục thuộc chính user chạy test, không có bit group/other. Trên host thường thư mục này thuộc `root` mode `0700`, nên chạy ngoài container sẽ thấy `closed` hoặc traceback thay vì `idle`:

- `test_security.py::AdmissionTests::test_fresh_shell_import_does_not_load_core_or_registry`
- `test_security.py::AdmissionTests::test_upstream_registry_unchanged_by_shell_lifecycle`
- `test_server.py::PackagedASGITests::test_packaged_read_only_inspection_uses_inspect_scope_and_real_lifespan`

Đây là hành vi fail-closed đúng của [runtime.py](../kag/http_api/runtime.py); chạy các test này bằng lệnh Docker ở Bước 3: `--tmpfs /provider-state:rw,uid=10001,gid=10001,mode=0700` cấp thư mục riêng cho `--user 10001:10001`. Không đổi quyền thư mục trên máy dev hoặc dùng state sản phẩm.

Audit hook kiểm unlink symlink theo directory entry, không resolve target. Kiểm Docker/API có thể tạo tài khoản/state; cần môi trường thử riêng theo [WebApp](../WebApp/README.md).
