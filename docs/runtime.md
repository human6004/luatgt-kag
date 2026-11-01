# Runtime Python và upstream KAG

Chuẩn: **CPython 3.10.16, Linux amd64**. Bootstrap kiểm đúng version trong [`.python-version`](../.python-version). Windows dùng Linux containers. Cài sản phẩm theo [INSTALL](INSTALL.md), không cần Python host.

Upstream **KAG 0.8.0**, submodule `vendor/KAG`, pin `fdab15b3929d2ee40dfcdd388f90233096a6afc9` trong [bootstrap.py](../kag/bootstrap.py). Dependencies: [requirements.txt](../requirements.txt). Không cài thêm wheel KAG cạnh source.

## Runtime dành cho phát triển

**Bước 1 — Build:** từ root checkout có submodule:

```powershell
docker build --platform linux/amd64 -f docker/kag-runtime/Dockerfile -t vietroadtraffic-kag-runtime:local .
```

Image pin base OpenSPG, tạo venv riêng và chạy `pip check`; cần mạng khi build.

**Bước 2 — Kiểm version offline:**

```powershell
docker run --rm --platform linux/amd64 --network none --mount "type=bind,source=$($PWD.Path),target=/workspace,readonly" vietroadtraffic-kag-runtime:local
```

Kết quả: phiên bản Python; không mở graph/provider. Linux thay `source=$($PWD.Path)` bằng `source=$(pwd)`. Source chỉ đọc, giữ `.git` để bootstrap kiểm pin.

Có thể dùng venv ngoài repo nếu host đã có đúng Python/Linux/architecture; cài requirements và `pip check` trước [tests](../tests/README.md). Không dùng Python khác version thay runtime chuẩn.

## Chuẩn bị dataset và plan offline để bàn giao

Dùng checkout có submodule và nội dung LFS thật theo [INSTALL](INSTALL.md#2-lấy-source). Người nhận cần toàn bộ `data/`, `artifacts/inputs/xref-a3g2/`, `kag/`, runtime requirements và upstream được pin trong cùng phiên bản repo. Không cần workspace, báo cáo, helper, `.env` hay venv của người bàn giao.

Trên Linux amd64 hoặc WSL, có **CPython 3.10.16**; từ root checkout, tạo môi trường và nơi lưu mới ngoài repo:

```sh
python3.10 -m venv ../luatgt-offline-venv
../luatgt-offline-venv/bin/python -m pip install -r requirements.txt -r requirements-http-api.txt
../luatgt-offline-venv/bin/python -m pip check
../luatgt-offline-venv/bin/python -B -c "from pathlib import Path; from kag.builder.control import prepare_source_inputs; print(prepare_source_inputs(Path('../luatgt-build-state').resolve())[0])"
```

Tên hai thư mục ngoài repo tùy người nhận; không tái sử dụng state của graph đang chạy. `requirements-http-api.txt` bổ sung FastAPI, chỉ dùng `-c` để ràng buộc các pin còn lại, nên cần cài cả hai requirements.

Lệnh cuối gọi cùng hàm **Kiểm tra và chuẩn bị** của Builder, không khởi động HTTP server, không dùng endpoint/credentials, không gọi Embedding và không ghi graph. Kết quả `VALID` kèm plan hash, số node/cạnh; `plans/<plan-hash>/` dưới thư mục state chứa `manifest.json`, `nodes.jsonl`, `edges.jsonl`, `plan.sha256` và dữ liệu kiểm offline. Loader kiểm hash, ID/parent, SAFE/no-edge và schema; kết quả này không chứng nhận toàn bộ nội dung pháp lý đã được rà nguồn.

Người nhận muốn dựng graph thật: cấu hình deployment và model/đích riêng theo [INSTALL](INSTALL.md), rồi theo [Runner](runner.md#dựng-đồ-thị-qua-5-bước). CLI `python -B -m kag run --config <runner.json> --run-id <id>` dùng cấu hình của người nhận theo [config](runner.md#config); đây là thao tác có thể gọi Embedding/ghi graph, không thuộc kiểm offline ở trên.

## Bootstrap

Entrypoint dùng SDK gọi trước SDK imports:

```python
from kag.bootstrap import initialize
initialize()
```

Bootstrap ghép namespace: Builder ưu tiên project rồi vendor; package upstream khác ưu tiên vendor. Initializer/registry upstream vẫn là nguồn chuẩn; gọi lại không đăng ký lại. Core offline không tự nạp SDK.

Từ chối vendor thiếu/sai pin/bẩn hoặc SDK ngoài pin đã nạp. Kiểm working tree chuẩn hóa CRLF/executable bit cho Windows; vẫn chặn file sửa/untracked. Không tự chèn `sys.path`, copy SDK, xóa package/init hoặc sửa vendor để né kiểm tra. `KAG_DEBUG_DUMP_CONFIG=0` ngăn dump secrets khi import.

## Inputs và images

Ba inputs canonical trong [`artifacts/inputs/xref-a3g2/`](../artifacts/inputs/xref-a3g2/); [`manifest.json`](../artifacts/inputs/xref-a3g2/manifest.json) giữ hashes/provenance, [`inputs.py`](../kag/builder/inputs.py) kiểm byte exact. Không phụ thuộc workspace tác giả, không fallback inputs hoặc sửa golden; `.gitattributes` bảo toàn bytes qua clone.

C3/C4.3a là tên contract/artifact còn được consumers dùng, không phải bước startup. Quyền ghi kiểm riêng tại [runner](runner.md#config) và [backend identity](backend-identity.md#writer-và-lock).

Compose/Dockerfiles là nguồn chuẩn image pins; không duy trì danh sách digest thứ hai trong Markdown. KAG API/Builder/OpenSPG dùng cùng image source. Cấu hình runtime/serving: [Docker](../docker/README.md).

Image sản phẩm còn chứa corpus và schema. Worker tạo kế hoạch nguồn qua **Kiểm tra và chuẩn bị**, lưu vào volume Builder state; không phụ thuộc kế hoạch/helper trong workspace phát triển. Python host và các lệnh phát triển bên trên không phải điều kiện để người dùng chạy Builder.

## Kiểm thử

[Tests](../tests/README.md) hướng dẫn suite riêng, source read-only, network denied, output ngoài repo và shared lock mount. Offline/import checks không xác nhận graph live hoặc benchmark pháp lý.
