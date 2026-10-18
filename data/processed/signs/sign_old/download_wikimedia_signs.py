"""Download Vietnamese road sign images directly from the Vietnamese Wikipedia article:
"Biển báo giao thông tại Việt Nam" and Wikimedia Commons.

Reads ``data/processed/signs/sign_merge.json`` and saves matching files to
``data/processed/signs/dataset_signs``. Wikimedia file metadata and attribution are recorded
in ``wikimedia_manifest.json``. Errors and missing signs are logged to
``download_errors.json`` and ``missing_signs.json``. Run without ``--download`` to preview matches.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

# Cấu hình UTF-8 cho console Windows
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


VI_WIKI_API = "https://vi.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKI_ARTICLE = "Biển_báo_giao_thông_tại_Việt_Nam"
USER_AGENT = "VietnameseRoadSignsDataset/1.0 (Wikipedia road sign downloader; contact: admin@roadsigns.vn)"
CACHE_FILE = "wikipedia_article_cache.json"
IMAGE_EXTENSIONS = {".svg", ".png", ".webp", ".jpg", ".jpeg"}


def api_get(url: str, params: dict[str, Any], retries: int = 5) -> dict[str, Any]:
    query = urlencode({"format": "json", "formatversion": 2, **params})
    request = Request(f"{url}?{query}", headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except HTTPError as error:
            if error.code != 429 or attempt == retries:
                raise
            retry_after = error.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else min(15 * (attempt + 1), 90)
            except ValueError:
                delay = min(15 * (attempt + 1), 90)
            print(f"API đang giới hạn truy vấn; thử lại sau {delay:g} giây…", file=sys.stderr)
            time.sleep(delay)
    if "error" in payload:
        raise RuntimeError(payload["error"].get("info", "Wikipedia/Commons API error"))
    return payload


def get_wikipedia_article_images(cache_path: Path) -> list[dict[str, Any]]:
    """Lấy danh sách tất cả các ảnh biển báo trong bài viết Wikipedia tiếng Việt."""
    if cache_path.is_file():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
            if cache.get("article") == WIKI_ARTICLE and cache.get("pages"):
                print(f"Dùng cache bài viết Wikipedia ({len(cache['pages'])} file ảnh đã xác minh).")
                return cache["pages"]
        except (OSError, json.JSONDecodeError):
            pass

    print(f"Đang lấy danh sách ảnh từ bài viết Wikipedia '{WIKI_ARTICLE}'…")
    payload = api_get(VI_WIKI_API, {
        "action": "parse",
        "page": WIKI_ARTICLE,
        "prop": "images",
    })
    raw_images = payload.get("parse", {}).get("images", [])
    sign_images = [
        img for img in raw_images
        if Path(img).suffix.casefold() in IMAGE_EXTENSIONS
        and not any(skip in img.lower() for skip in ("icon", "logo", "flag", "symbol", "stub"))
    ]
    print(f"Tìm thấy {len(sign_images)} file ảnh hợp lệ trong bài viết. Đang lấy metadata từ Wikimedia Commons…")

    # Lấy thông tin URL & metadata từ Wikimedia Commons theo từng đợt 50 file
    pages: list[dict[str, Any]] = []
    chunk_size = 50
    for i in range(0, len(sign_images), chunk_size):
        chunk = sign_images[i: i + chunk_size]
        titles = [f"File:{img}" for img in chunk]
        info_payload = api_get(COMMONS_API, {
            "action": "query",
            "titles": "|".join(titles),
            "prop": "imageinfo",
            "iiprop": "url|size|mime|extmetadata",
            "iiurlwidth": 1200,
        })
        for page in info_payload.get("query", {}).get("pages", []):
            if page.get("imageinfo"):
                pages.append(page)
        time.sleep(0.3)

    cache_path.write_text(json.dumps({
        "article": WIKI_ARTICLE,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "pages": pages,
    }, ensure_ascii=False), encoding="utf-8")
    return pages


def match_sign(code: str, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """So khớp mã biển báo với các file ảnh trong bài viết Wikipedia một cách an toàn."""
    targets = [code]
    # Biển DP (hết cấm) trên Wikimedia thường dùng bí danh tiền tố P
    if code.startswith("DP."):
        targets.append(code.replace("DP.", "P."))

    candidates: list[tuple[int, dict[str, Any]]] = []
    for page in pages:
        title = page.get("title", "")
        # Chuẩn hóa tên file: bỏ prefix File:, extension, và phần trong ngoặc đơn
        filename = title.removeprefix("File:")
        base_name = filename.rsplit(".", 1)[0]
        name_clean = re.sub(r"\(.*?\)", "", base_name)
        compact_title = re.sub(r"[^a-z0-9]", "", name_clean.casefold())

        for target in targets:
            compact_target = re.sub(r"[^a-z0-9]", "", target.casefold())
            # Kiểm tra khớp chính xác với các tiền tố chuẩn
            valid_patterns = {
                f"vietnamroadsign{compact_target}",
                f"bien{compact_target}",
                compact_target,
            }
            if compact_title in valid_patterns:
                # Ưu tiên:
                # 1. Có QCVN 2024 (+10 điểm)
                # 2. Định dạng SVG (+5 điểm)
                # 3. Có QCVN 2019 (+3 điểm)
                score = 0
                title_lower = title.lower()
                if "2024" in title_lower:
                    score += 10
                elif "2019" in title_lower:
                    score += 3
                if title.casefold().endswith(".svg"):
                    score += 5
                candidates.append((score, page))

    if candidates:
        # Sắp xếp ưu tiên điểm cao nhất
        candidates.sort(key=lambda x: -x[0])
        return [c[1] for c in candidates]
    return []


def download_file(url: str, destination: Path, retries: int = 5, base_delay: float = 2.0) -> None:
    """Tải file từ Wikimedia Commons kèm cơ chế tự động thử lại khi gặp mã lỗi 429 (Rate Limit)."""
    request = Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=30) as response, destination.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            return
        except HTTPError as error:
            if error.code == 429 and attempt < retries:
                retry_after = error.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else base_delay * (2 ** attempt)
                except ValueError:
                    delay = base_delay * (2 ** attempt)
                print(f" [429 Rate Limit] Wikimedia giới hạn tải; chờ {delay:g}s trước khi thử lại…", file=sys.stderr)
                time.sleep(delay)
                continue
            raise
        except (URLError, TimeoutError, OSError) as error:
            if attempt < retries:
                time.sleep(base_delay * (attempt + 1))
                continue
            raise


def metadata_value(extmetadata: dict[str, Any], key: str) -> str:
    value = extmetadata.get(key, {}).get("value", "")
    return re.sub(r"<[^>]+>", "", str(value)).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="tải các file ảnh đã khớp về máy")
    parser.add_argument("--overwrite", action="store_true", help="ghi đè file nếu đã tồn tại")
    parser.add_argument("--include-inactive", action="store_true", help="tải cả các mã đã hết hiệu lực (chỉ có ở 2019)")
    parser.add_argument("--limit", type=int, help="giới hạn số lượng biển xử lý (để chạy thử nghiệm)")
    parser.add_argument("--clean-junk", action="store_true", help="xóa các file ảnh rác trước đó (như DP.127.jpg, DP.133.jpg...)")
    parser.add_argument("--output-dir", type=str, help="thư mục lưu ảnh tải về (mặc định: data/processed/signs/dataset_signs)")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    signs_dir = root / "data" / "processed" / "signs"
    output_dir = Path(args.output_dir).resolve() if args.output_dir else (signs_dir / "dataset_signs")
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = signs_dir / "sign_merge.json"
    if not input_path.is_file():
        print(f"Không tìm thấy file dữ liệu biển báo: {input_path}", file=sys.stderr)
        return 2

    # Dọn dẹp file ảnh rác nếu được yêu cầu
    if args.clean_junk:
        junk_files = ["DP.127.jpg", "DP.133.jpg", "DP.134.jpg", "DP.135.jpg"]
        for target_folder in [signs_dir, output_dir]:
            for jf in junk_files:
                p = target_folder / jf
                if p.is_file():
                    p.unlink()
                    print(f"Đã dọn dẹp file rác: {p.relative_to(root)}")

    raw_records = json.loads(input_path.read_text(encoding="utf-8"))
    record_map: dict[str, dict[str, Any]] = {}
    for r in raw_records:
        code = r.get("ma_bien")
        if code and (code not in record_map or r.get("hien_hanh", False)):
            record_map[code] = r

    codes = list(dict.fromkeys(
        record["ma_bien"] for record in raw_records
        if args.include_inactive or record.get("hien_hanh", True)
    ))
    if args.limit is not None:
        if args.limit < 1:
            parser.error("--limit phải lớn hơn 0")
        codes = codes[: args.limit]

    try:
        wiki_pages = get_wikipedia_article_images(signs_dir / CACHE_FILE)
    except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
        print(f"Không lấy được dữ liệu từ Wikipedia/Wikimedia: {error}", file=sys.stderr)
        return 1

    manifest_path = signs_dir / "wikimedia_manifest.json"
    errors_path = signs_dir / "download_errors.json"
    missing_path = signs_dir / "missing_signs.json"
    summary_path = signs_dir / "download_summary.json"

    manifest: dict[str, Any] = {}
    if manifest_path.exists() and not args.overwrite:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = {}

    download_errors: list[dict[str, Any]] = []
    missing_signs: list[dict[str, Any]] = []
    matched = downloaded = skipped = 0

    print(f"\nThư mục lưu ảnh: {output_dir.relative_to(root)}")
    print(f"Bắt đầu so khớp và xử lý {len(codes)} mã biển báo…\n")

    for index, code in enumerate(codes, 1):
        matches = match_sign(code, wiki_pages)
        if not matches:
            missing_signs.append({
                "ma_bien": code,
                "ten": record_map.get(code, {}).get("ten", ""),
                "nhom": record_map.get(code, {}).get("nhom", ""),
                "hien_hanh": record_map.get(code, {}).get("hien_hanh", True),
            })
            print(f"[{index}/{len(codes)}] {code}: chưa có ảnh trong bài viết Wikipedia")
            continue

        matched += 1
        page = matches[0]
        title = page["title"]
        info = page["imageinfo"][0]
        extension = Path(title).suffix.casefold()
        destination = output_dir / f"{code}{extension}"

        record = {
            "ma_bien": code,
            "file": f"dataset_signs/{destination.name}",
            "file_name": destination.name,
            "commons_title": title,
            "page_url": f"https://commons.wikimedia.org/wiki/{quote(title.replace(' ', '_'))}",
            "source_url": info.get("url"),
            "license": metadata_value(info.get("extmetadata", {}), "LicenseShortName"),
            "license_url": metadata_value(info.get("extmetadata", {}), "LicenseUrl"),
            "artist": metadata_value(info.get("extmetadata", {}), "Artist"),
            "credit": metadata_value(info.get("extmetadata", {}), "Credit"),
        }

        if args.download:
            if destination.exists() and not args.overwrite:
                skipped += 1
                manifest[code] = record
                print(f"[{index}/{len(codes)}] {code}: đã có {destination.name}, bỏ qua")
            else:
                try:
                    download_file(info["url"], destination)
                    downloaded += 1
                    manifest[code] = record
                    print(f"[{index}/{len(codes)}] {code}: đã tải {destination.name} ({title})")
                    # Nghỉ ngắn giữa các file để tránh bị Wikimedia kích hoạt 429
                    time.sleep(0.35)
                except (HTTPError, URLError, TimeoutError, OSError) as error:
                    download_errors.append({
                        "ma_bien": code,
                        "title": title,
                        "url": info.get("url"),
                        "destination": str(destination.name),
                        "error": f"{type(error).__name__}: {error}",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    print(f"[{index}/{len(codes)}] {code}: LỖI TẢI FILE: {error}", file=sys.stderr)
        else:
            print(f"[{index}/{len(codes)}] {code}: khớp với {title} → {destination.name}")

    # Ghi log và thống kê
    if args.download:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        errors_path.write_text(json.dumps(download_errors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        missing_path.write_text(json.dumps(missing_signs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        summary = {
            "run_at": datetime.now(timezone.utc).isoformat(),
            "total_processed": len(codes),
            "matched_on_wikipedia": matched,
            "downloaded_new": downloaded,
            "already_existed": skipped,
            "download_errors_count": len(download_errors),
            "missing_from_wikipedia_count": len(missing_signs),
            "output_directory": str(output_dir.relative_to(root)),
        }
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        print("\n" + "=" * 60)
        print("TỔNG KẾT KẾT QUẢ TẢI ẢNH BIỂN BÁO:")
        print(f" - Tổng số mã biển xử lý:       {len(codes)}")
        print(f" - Khớp ảnh trên Wikipedia:      {matched}/{len(codes)} ({matched/len(codes)*100:.1f}%)")
        print(f" - Tải mới thành công:          {downloaded}")
        print(f" - Đã có sẵn (bỏ qua):          {skipped}")
        print(f" - Tải thất bại (lỗi mạng/429): {len(download_errors)}")
        print(f" - Chưa có trên Wikipedia:      {len(missing_signs)}")
        print(f" - Thư mục lưu ảnh:             {output_dir.relative_to(root)}")
        print(f" - File Manifest:               {manifest_path.relative_to(root)}")
        print(f" - File Log lỗi tải:            {errors_path.relative_to(root)} ({len(download_errors)} lỗi)")
        print(f" - File Danh sách biển thiếu:   {missing_path.relative_to(root)} ({len(missing_signs)} biển)")
        print("=" * 60)
    else:
        print("\n" + "=" * 60)
        print("KẾT QUẢ XEM TRƯỚC (PREVIEW):")
        print(f" - Tổng số mã biển xử lý:       {len(codes)}")
        print(f" - Khớp ảnh trên Wikipedia:      {matched}/{len(codes)} ({matched/len(codes)*100:.1f}%)")
        print(f" - Chưa có ảnh trên Wikipedia:  {len(missing_signs)}")
        print("Chạy lại kèm tham số `--download` để bắt đầu tải về máy.")
        print("=" * 60)

    return 0 if not download_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
