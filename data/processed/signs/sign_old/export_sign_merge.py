"""Script trích xuất và gộp dữ liệu biển báo từ signs.jsonl thành sign_merge.json.

Gộp 436 mã biển chung + 5 mã chỉ có ở 2019 + 10 mã mới chỉ có ở 2024 = 451 mã duy nhất.
Đánh dấu rõ ràng bằng `merge_status`, `ghi_chu`, `cac_quy_chuan` và `hien_hanh`.
"""

import json
from pathlib import Path


def main():
    root_dir = Path(__file__).resolve().parent.parent
    signs_file = root_dir / "data" / "processed" / "signs" / "signs.jsonl"
    output_file = root_dir / "data" / "processed" / "signs" / "sign_merge.json"

    signs = [json.loads(line) for line in signs_file.open(encoding="utf-8")]

    s2019 = {s["ma_bien"]: s for s in signs if s["doc_id"] == "54_2019_TT_BGTVT"}
    s2024 = {s["ma_bien"]: s for s in signs if s["doc_id"] == "51_2024_TT_BGTVT"}

    all_ma = sorted(list(set(s2019.keys()) | set(s2024.keys())))

    merged = []
    for ma in all_ma:
        in_19 = ma in s2019
        in_24 = ma in s2024

        if in_19 and in_24:
            base = dict(s2024[ma])
            item = {
                "ma_bien": base["ma_bien"],
                "ten": base["ten"],
                "nhom": base["nhom"],
                "merge_status": "BOTH",
                "ghi_chu": "Có ở cả QCVN 41:2019 và QCVN 41:2024 (Dữ liệu chi tiết lấy theo bản 2024 hiện hành)",
                "cac_quy_chuan": [
                    "QCVN 41:2019/BGTVT",
                    "QCVN 41:2024/BGTVT",
                ],
                "hien_hanh": True,
                "sign_id": base["sign_id"],
                "bien_phu_variant": base.get("bien_phu_variant", ""),
                "mo_ta": base["mo_ta"],
                "qcvn": base["qcvn"],
                "so_hieu": base["so_hieu"],
                "doc_id": base["doc_id"],
                "unit_id": base["unit_id"],
                "unit_id_2019": s2019[ma]["unit_id"],
                "ngay_hieu_luc": base["ngay_hieu_luc"],
                "ngay_het_hieu_luc": base["ngay_het_hieu_luc"],
            }
        elif in_19 and not in_24:
            base = dict(s2019[ma])
            item = {
                "ma_bien": base["ma_bien"],
                "ten": base["ten"],
                "nhom": base["nhom"],
                "merge_status": "ONLY_2019",
                "ghi_chu": "Chỉ có trong QCVN 41:2019/BGTVT (đã bãi bỏ hoặc thay đổi trong QCVN 41:2024)",
                "cac_quy_chuan": [
                    "QCVN 41:2019/BGTVT",
                ],
                "hien_hanh": False,
                "sign_id": base["sign_id"],
                "bien_phu_variant": base.get("bien_phu_variant", ""),
                "mo_ta": base["mo_ta"],
                "qcvn": base["qcvn"],
                "so_hieu": base["so_hieu"],
                "doc_id": base["doc_id"],
                "unit_id": base["unit_id"],
                "ngay_hieu_luc": base["ngay_hieu_luc"],
                "ngay_het_hieu_luc": base["ngay_het_hieu_luc"],
            }
        else:  # in_24 and not in_19
            base = dict(s2024[ma])
            item = {
                "ma_bien": base["ma_bien"],
                "ten": base["ten"],
                "nhom": base["nhom"],
                "merge_status": "ONLY_2024",
                "ghi_chu": "Mã biển mới bổ sung trong QCVN 41:2024/BGTVT (chưa từng có trong QCVN 41:2019)",
                "cac_quy_chuan": [
                    "QCVN 41:2024/BGTVT",
                ],
                "hien_hanh": True,
                "sign_id": base["sign_id"],
                "bien_phu_variant": base.get("bien_phu_variant", ""),
                "mo_ta": base["mo_ta"],
                "qcvn": base["qcvn"],
                "so_hieu": base["so_hieu"],
                "doc_id": base["doc_id"],
                "unit_id": base["unit_id"],
                "ngay_hieu_luc": base["ngay_hieu_luc"],
                "ngay_het_hieu_luc": base["ngay_het_hieu_luc"],
            }
        merged.append(item)

    with output_file.open("w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    print(f"Xong! Da xuat {len(merged)} ban ghi vao: {output_file}")
    both_cnt = sum(1 for x in merged if x["merge_status"] == "BOTH")
    o19_cnt = sum(1 for x in merged if x["merge_status"] == "ONLY_2019")
    o24_cnt = sum(1 for x in merged if x["merge_status"] == "ONLY_2024")
    print(f"- BOTH: {both_cnt}")
    print(f"- ONLY_2019: {o19_cnt}")
    print(f"- ONLY_2024: {o24_cnt}")


if __name__ == "__main__":
    main()
