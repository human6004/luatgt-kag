# Dữ liệu pháp luật giao thông đường bộ

Bộ dữ liệu tiếng Việt gồm luật, nghị định, thông tư, QCVN và văn bản hợp nhất. `data/` giữ nguồn và dữ liệu chuẩn hóa; Builder/Retriever/Solver nằm trong `kag/`.

## Nguồn và phạm vi

Nguồn pháp luật lấy từ Công báo Chính phủ và CDN đi kèm. [sources.csv](metadata/sources.csv) lưu URL nguồn và file gốc; [document_inventory.csv](metadata/document_inventory.csv) giữ danh mục và phạm vi văn bản. Điều kiện sử dụng, phân biệt luật gốc với phần pipeline tạo ra: [LICENSE.md](LICENSE.md).

Corpus có 92 bản ghi metadata, 91 văn bản Markdown thuộc production corpus. `22_VBHN_BXD` nằm riêng trong `processed/out_of_scope/`; không trộn vào corpus truy xuất hoặc graph.

## Cấu trúc

- `raw/`: 215 file nguồn — 171 PDF, 38 HTML, 6 DOC/DOCX; dùng đối chiếu.
- `processed/documents/`: toàn văn Markdown theo `doc_id`.
- `processed/units/units.jsonl`: Điều/Khoản/Điểm, phụ lục và QCVN; giữ `unit_id`, `parent_id`, `unit_type`, `text`.
- `processed/meta/`: `documents.jsonl`, `xrefs.jsonl`, `relations.jsonl`.
- `processed/penalties/`: chế tài theo hành vi, giữ nguồn khoản tiền trong `fine_rule` và điều kiện/nguyên văn chế tài trong `sanction_rules`; dữ liệu ngoài phạm vi ở `excluded_out_of_scope.jsonl`.
- `processed/signs/signs_app.json`: master biển báo, phân biệt nhóm/biến thể, nguồn và quyết định rà; `signs.jsonl` dẫn xuất cho Builder. `dataset_signs/` giữ SVG ảnh chính theo bảy nhóm; hai năm dùng chung khi hình khớp, chỉ thêm hậu tố năm khi hình khác. Thiếu SVG phù hợp được ghi `missing`; trạng thái ảnh và pháp lý tách riêng. Đã bỏ PNG và thư mục ảnh nguồn cũ khỏi dataset; Git ref/path gốc vẫn được giữ trong provenance. Xem [DATASHEET](DATASHEET.md#biển-báo-qcvn-41).
- `processed/eval/eval_questions.jsonl`: 71 câu đánh giá nguồn, không thuộc retrieval corpus.
- `processed/out_of_scope/`: văn bản và records ngoài corpus.
- `metadata/`: thống kê, nguồn, danh mục và SHA-256.

`doc_id` nối các lớp dữ liệu. Ví dụ `100_2019_ND_CP::D5::K1::Pa` chỉ văn bản, Điều 5, Khoản 1, Điểm a. Giữ nguyên ID nguồn.

`xrefs` là dẫn chiếu trong nội dung, thường tới Điều/Khoản/Điểm. `relations` là quan hệ giữa văn bản: `cites`, `amends`, `repeals`, `replaces`, `implements`, `consolidates`. `replaces` giữ nghĩa thay thế, không đồng nhất với bãi bỏ.

## Thống kê corpus

[corpus.json](metadata/corpus.json) ghi snapshot `2026-10-23`; [checksums.json](metadata/checksums.json) giữ hash dữ liệu. Số lượng records:

- Documents metadata: 92; production Markdown: 91.
- Units: 55.572.
- Xrefs: 21.357.
- Relations: 834.
- Penalties: 1.820.
- Signs: 907; trạng thái nguồn và giới hạn ảnh ở [DATASHEET](DATASHEET.md#biển-báo-qcvn-41).

Tên “production corpus” phân biệt phạm vi dữ liệu, không xác nhận triển khai production hoặc tính cập nhật của pháp luật.

## Lưu ý sử dụng

Chỉ xref được phân loại `SAFE_EDGE` mới có thể thành cạnh graph. `in_corpus=true` không chứng minh endpoint hay ngữ nghĩa hợp lệ. Ledger/policy canonical nằm tại [artifacts/inputs/xref-a3g2](../artifacts/inputs/xref-a3g2/); `load_inputs` kiểm hash, fingerprint join và endpoint trước mapping. Không suy cạnh từ ID gần nhất hoặc bỏ polarity `is_exclusion`.

71 câu nguồn chưa phải dataset benchmark chính thức của Evaluation Framework. Đã rà gold theo nguồn: 64 câu `verified`, 7 câu biển báo chưa đủ căn cứ và giữ `verified=false`. Không đưa câu đánh giá vào nguồn luật; chuyển đổi/review theo [benchmark](../benchmark/README.md).

Chế tài có điều kiện hoặc nhiều nhóm đối tượng không được rút thành một mức áp dụng chung. `null` nghĩa là chưa biểu diễn được bằng scalar hoặc chưa đủ căn cứ, không phải mức 0 hay không phạt. Ba record có lỗi số tiền ngay trong bản Công báo giữ `fine_rule.source_discrepancy`; không suy số tiền từ giá trị chuẩn hóa cũ.

Nội dung trích tự động có thể sai OCR, bảng/phụ lục, mức phạt và ngày hiệu lực. Đối chiếu bản gốc qua `source_url`, quan hệ sửa đổi/thay thế và hiệu lực từng phần trước khi trích dẫn. Dataset không thay thế văn bản chính thức hay tư vấn pháp lý.

Chi tiết phạm vi và giới hạn: [DATASHEET.md](DATASHEET.md).
