# Thông tin dataset

**Tên:** Vietnamese Road Traffic Legal Dataset. **Ngôn ngữ:** tiếng Việt. **Mục đích:** chuẩn hóa pháp luật giao thông đường bộ cho truy xuất, graph và đánh giá.

## Nguồn và cấu trúc

Văn bản pháp luật lấy từ Công báo Chính phủ và CDN đi kèm. `raw/` giữ PDF/HTML/DOC nguồn; `processed/` giữ Markdown, units, quan hệ, tham chiếu, mức phạt và biển báo. URL từng văn bản ở [sources.csv](metadata/sources.csv), danh mục/phạm vi ở [document_inventory.csv](metadata/document_inventory.csv).

[README dữ liệu](README.md) mô tả từng thư mục, ID và cách dùng xrefs.

## Snapshot corpus

[corpus.json](metadata/corpus.json) ghi `dataset_date=2026-10-02`; [checksums.json](metadata/checksums.json) giữ SHA-256.

Số lượng từng loại dữ liệu được trình bày tại [Thống kê corpus](README.md#thống-kê-corpus), đối chiếu với metadata của snapshot.

`22_VBHN_BXD` được lưu trong `processed/out_of_scope/`, không thuộc corpus chính. `processed/eval/` giữ 71 câu đánh giá nguồn, không thuộc nguồn truy xuất và chưa là benchmark chính thức.

Snapshot mô tả dữ liệu đã lưu; không xác nhận mọi văn bản đang có hiệu lực hoặc corpus bao phủ mọi thay đổi pháp luật.

## Giới hạn và điều kiện sử dụng

- Text trích tự động có thể sai ở OCR, ký tự, bảng biểu và phụ lục; bản Công báo cũng có thể có lỗi nguồn.
- Mức phạt được ghép tự động, chưa kiểm duyệt toàn bộ; ngày hiệu lực có thể áp dụng theo từng phần.
- Dẫn chiếu có thể ngoài corpus, thiếu endpoint hoặc chưa rõ ngữ nghĩa; chỉ dùng policy `SAFE_EDGE` đã kiểm.
- Dữ liệu cấu trúc và câu hỏi đánh giá là phần pipeline tạo ra, cần phân biệt với luật gốc.

Đối chiếu văn bản gốc tại `source_url` trước khi trích dẫn. Dataset không thay thế văn bản pháp luật chính thức hoặc tư vấn pháp lý. Điều kiện sử dụng và căn cứ nguồn: [LICENSE.md](LICENSE.md).
