# Xuất bản 58 biển báo giống máy Nhân

Cần: đã `git pull` bản mới nhất, `docker compose up -d --build` chạy đủ 12 service, đăng nhập được WebApp bằng tài khoản ADMIN trong `.env`.

## 1. Nhập dữ liệu (WebApp → Nội dung luật → Nhập hàng loạt)

Làm đúng thứ tự, mỗi lần bấm **Xác nhận nhập bản nháp**:

1. Tab **Văn bản**: chọn `1-van-ban.json` (2 văn bản).
2. Tab **Điều khoản**: chọn `2-dieu-khoan.json` (211 điều khoản).
3. Tab **Biển báo**: nếu chưa có 453 biển, chọn `data/processed/signs/signs_app.json` trong repo.

Chỉ nhập, **không** tự bấm xuất bản.

## 2. Chạy script xuất bản

Mở PowerShell tại **root repo luatgt-kag** (thư mục có `.env`):

```powershell
pip install requests python-dotenv
python <đường-dẫn-thư-mục-này>\publish-60.py --preflight
python <đường-dẫn-thư-mục-này>\publish-60.py
```

- `--preflight` chỉ kiểm tra, không ghi gì. Phải thấy dòng `Bước 0: đạt 58/60. Loại: IE.469-1 ..., IE.469-2 ...`.
- Lệnh thứ hai: upload PDF `data/raw/pdf/51_2024_TT_BGTVT.pdf`, xuất bản văn bản 51/2024, điều khoản D47 + D32, rồi 58 biển.
- Script tự dừng nếu dữ liệu khác dự kiến (ví dụ đã có biển xuất bản từ trước). Khi đó gửi file `publish-60.log` cho Nhân.

## Kết quả đúng

Tab Biển báo: **Đã xuất bản = 58** (57 biển cao tốc + R.412p).
391 biển còn lại chưa xuất bản vì đang trỏ sai căn cứ (Điều 84), sẽ sửa sau.
