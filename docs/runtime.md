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
