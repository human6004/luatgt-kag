from collections import Counter
from pathlib import Path
import json
import re
import sys

import requests
from dotenv import dotenv_values

ROOT = Path.cwd()  # chạy lệnh tại root repo luatgt-kag
HERE = Path(__file__).parent
DOC = "51_2024_TT_BGTVT"
PREFIX = DOC + "::QCVN41_2024_BGTVT::"
UNITS = {PREFIX + "D47", PREFIX + "D32"}
QCVN = "QCVN 41:2024/BGTVT"
PDF = ROOT / "data/raw/pdf/51_2024_TT_BGTVT.pdf"
DOCS = "/admin/documents"
UNIT_LIST = "/admin/units?docId=" + DOC
SIGNS = "/admin/signs"
SECRETS = []

class Stop(Exception):
    pass

class ApiError(Stop):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)

def log(message):
    message = str(message)
    for secret in SECRETS:
        if secret:
            message = message.replace(secret, "[REDACTED]")
    print(message, flush=True)
    with (HERE / "publish-60.log").open("a", encoding="utf-8") as out:
        print(message, file=out)

def require(condition, message):
    if not condition:
        raise Stop(message)

def api(method, route, raw=False, **kwargs):
    try:
        response = session.request(method, base + route, allow_redirects=False, timeout=45, **kwargs)
    except requests.RequestException as exc:
        raise Stop(f"{method} {route}: {type(exc).__name__}. Kiểm tra trạng thái API trước khi thử lại.") from None
    if not response.ok or response.is_redirect:
        detail = ""
        if route != "/auth/login" and 400 <= response.status_code < 500:
            try:
                detail = str(response.json().get("message", ""))[:12000]
            except (ValueError, AttributeError):
                pass
        raise ApiError(response.status_code, f"{method} {route}: HTTP {response.status_code} {detail}".rstrip())
    if raw:
        return response
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise Stop(f"{method} {route}: phản hồi không phải JSON") from None

def one(route, external_id):
    rows = [row for row in api("GET", route) if row["externalId"] == external_id]
    require(len(rows) == 1, f"Không tìm được đúng một bản ghi {external_id}")
    return rows[0]

def retry_conflict(operation):
    try:
        return operation()
    except ApiError as exc:
        if exc.status != 409:
            raise
        log("HTTP 409. Đọc lại phiên bản và thử lại một lần.")
        return operation()

def unit(row):
    return row["data"].get("unit_id", "")

def code(row):
    return row["data"].get("code") or row["data"].get("ma_bien")

def publication_counts(rows):
    counts = Counter(unit(r).rsplit("::", 1)[-1] for r in rows if r["published"])
    return ", ".join(f"{u}={counts[u]}" for u in ("D47", "D32", "D84", "D90"))

def candidates(rows):
    selected = [r for r in rows if unit(r) in UNITS]
    require(all(r["data"].get("doc_id") in (None, DOC) and r["data"].get("qcvn") == QCVN for r in selected),
            "Có bản ghi D47/D32 sai văn bản hoặc QCVN")
    counts = Counter(unit(r).rsplit("::", 1)[-1] for r in selected)
    require(counts == {"D47": 59, "D32": 1} and
            {code(r) for r in selected if unit(r) == PREFIX + "D32"} == {"R.412p"} and
            len({code(r) for r in selected if code(r)}) == 60 and len({r["id"] for r in selected}) == 60,
            f"Danh sách API khác phạm vi 59 D47 + R.412p D32: {dict(counts)}")
    return selected

def publish_source(list_route, resource, external_id, check):
    def edit():
        row = one(list_route, external_id)
        check(row)
        if not row["data"].get("reviewed"):
            api("PUT", f"{resource}/{row['id']}",
                json={"version": row["version"], "data": {**row["data"], "reviewed": True}})

    def publish():
        row = one(list_route, external_id)
        check(row)
        require(row["data"].get("reviewed") is True, f"{external_id}: reviewed chưa bật")
        if not row["published"]:
            api("POST", f"{resource}/{row['id']}/publication", json={"version": row["version"], "published": True})

    retry_conflict(edit)
    retry_conflict(publish)
    row = one(list_route, external_id)
    check(row)
    require(row["published"] is True, f"{external_id}: API chưa xác nhận published=true")
    log(f"Đã xác nhận nguồn xuất bản: {external_id}")

def main():
    global base, session
    config = dotenv_values(ROOT / ".env", encoding="utf-8-sig", interpolate=False)
    email, password = config.get("ADMIN_EMAIL"), config.get("ADMIN_PASSWORD")
    require(bool(email and password), "Thiếu cấu hình đăng nhập ADMIN")
    SECRETS.extend((email, password))
    port = int(config.get("BACKEND_PORT") or 8080)
    base = f"http://127.0.0.1:{port}/api"
    session = requests.Session()
    session.trust_env = False
    login = api("POST", "/auth/login", json={"email": email, "password": password})
    token = login["accessToken"]
    SECRETS.append(token)
    require(login["user"]["role"] == "ADMIN", "Tài khoản API không có vai trò ADMIN")
    session.headers["Authorization"] = f"Bearer {token}"
    log(f"Đăng nhập ADMIN thành công. Backend cổng {port}.")

    require((ROOT / ".env").is_file() and PDF.is_file(), "Hãy chạy lệnh tại root repo luatgt-kag (cần .env và data/raw/pdf)")
    source_file = HERE / "2-dieu-khoan.json"
    source = {r["unit_id"]: r["text"] for r in json.loads(source_file.read_text(encoding="utf-8-sig"))
              if r["doc_id"] == DOC and r["unit_id"] in UNITS}
    require(set(source) == UNITS, "Thiếu D47 hoặc D32 trong nguồn đối chiếu")

    def unit_check(row):
        require(row["data"].get("doc_id") == DOC and row["data"].get("text") == source.get(unit(row)),
                f"Văn bản hoặc text unit live khác tệp đối chiếu: {row['externalId']}")

    for u in sorted(UNITS):
        unit_check(one(UNIT_LIST, u))
    # Both unit records are tied to DOC. validate() fills absent sign doc_id from the unit.
    all_signs = api("GET", SIGNS)
    scoped = candidates(all_signs)
    baseline = {r["id"] for r in all_signs if r["published"]}
    require(not baseline, f"Trạng thái xuất bản ban đầu khác yêu cầu: {publication_counts(all_signs)}")
    approved = {}
    rejected = []
    for row in scoped:
        pattern = r"(?<![A-Za-z0-9])" + re.escape(code(row)) + r"(?![A-Za-z0-9]|[.-][A-Za-z0-9])"
        if re.search(pattern, source[unit(row)]):
            approved[row["id"]] = row
        else:
            rejected.append(f"{code(row)} (không thấy nguyên mã trong {unit(row).split('::')[-1]})")
    require(bool(approved), "Không có biển đạt đối chiếu")
    log(f"Bước 0: đạt {len(approved)}/60. Loại: {', '.join(sorted(rejected)) or '0'}.")
    log(f"Trước xuất bản: {publication_counts(all_signs)}.")
    if "--preflight" in sys.argv:
        return

    def document_check(row):
        require(bool(row["data"].get("fileKey")), "Upload PDF chưa tạo fileKey")

    def upload():
        row = one(DOCS, DOC)
        require(not row["published"], "Văn bản đã xuất bản trước upload")
        if row["data"].get("fileKey"):
            existing = api("GET", f"/content/{row['id']}/media", raw=True)
            require(existing.content == PDF.read_bytes(), "Văn bản đang có PDF khác. Dừng trước khi ghi đè.")
            return
        require(5 <= PDF.stat().st_size <= 20 * 1024 * 1024, "PDF nguồn sai kích thước")
        with PDF.open("rb") as file:
            api("POST", f"/admin/content/{row['id']}/media",
                files={"file": (PDF.name, file, "application/pdf")})

    retry_conflict(upload)
    document_check(one(DOCS, DOC))
    log("Upload PDF: fileKey đã có.")
    publish_source(DOCS, "/admin/content", DOC, document_check)
    for u in (PREFIX + "D47", PREFIX + "D32"):
        publish_source(UNIT_LIST, "/admin/units", u, unit_check)

    def batch():
        live = {r["id"]: r for r in candidates(api("GET", SIGNS))}
        payload = []
        for id_, old in approved.items():
            row = live.get(id_)
            require(row and unit(row) in UNITS and not unit(row).endswith(("::D84", "::D90")) and
                    row["data"] == old["data"] and not row["published"],
                    f"Biển đổi dữ liệu hoặc phạm vi sau đối chiếu: {code(old)}")
            payload.append({"id": id_, "version": row["version"]})
        api("POST", SIGNS + "/publication-batch",
            json={"rows": payload, "reviewed": True, "published": True})

    try:
        retry_conflict(batch)
    except Stop:
        log("Sau lỗi batch: " + publication_counts(api("GET", SIGNS)))
        raise
    log("Batch: API chấp nhận.")

    final = api("GET", SIGNS)
    user_response = api("GET", "/signs", raw=True)
    visible = user_response.json()
    actual = {r["id"] for r in final if r["published"]}
    log("Admin published: " + publication_counts(final))
    log(f"GET /api/signs: HTTP {user_response.status_code}, {len(visible)} biển.")
    require(actual == set(approved) and {r["id"] for r in visible} == actual and len(visible) == len(actual) and
            all(r["data"].get("doc_id") == DOC for r in final if r["id"] in actual),
            "Danh sách hiển thị hoặc danh sách xuất bản lệch phạm vi dự kiến")

    with_images = [r for r in final if r["id"] in actual and
                   (r["data"].get("imageKey") or r["data"].get("hasDatasetImage"))]
    samples = sorted(with_images, key=lambda r: (code(r) != "R.412p", code(r)))[:2]
    require(len(samples) == 2, "Không có đủ 2 biển có ảnh để kiểm tra")
    image_results = []
    for row in samples:
        try:
            resp = api("GET", f"/content/{row['id']}/media", raw=True)
            mime = resp.headers.get("Content-Type", "")
            log(f"Ảnh {code(row)}: HTTP {resp.status_code}, {mime}, {len(resp.content)} bytes.")
            image_results.append(resp.status_code == 200 and mime.startswith("image/") and bool(resp.content))
        except Stop as exc:
            log(f"Ảnh {code(row)}: {exc}")
            image_results.append(False)
    require(all(image_results), "Kiểm tra ảnh chưa đạt")

try:
    main()
except Stop as exc:
    log(f"DỪNG: {exc}")
    sys.exit(1)
except Exception as exc:
    log(f"DỪNG: lỗi {type(exc).__name__}. Kiểm tra lại trạng thái API trước khi thử lại.")
    sys.exit(1)

