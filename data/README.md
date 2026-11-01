# Dữ liệu pháp luật giao thông đường bộ

Corpus tiếng Việt gồm 91 văn bản: luật, nghị định, thông tư, QCVN và văn bản hợp nhất. Nguồn Công báo Chính phủ và CDN chính thức được ghi tại [sources.csv](metadata/sources.csv). Điều kiện sử dụng: [LICENSE.md](LICENSE.md).

## Các file dữ liệu

- `raw/`: PDF, HTML và DOC/DOCX nguồn để đối chiếu. Nghị định 119/2024 giữ cả bản đăng lại và bản ký có phụ lục.
- `processed/documents/*.md`: toàn văn 91 văn bản; tên file là `doc_id`.
- `processed/meta/documents.jsonl`: `doc_id`, `so_hieu`, `title`, loại/cơ quan, URL và file nguồn, ngày ban hành/hiệu lực, phạm vi và trạng thái văn bản. Các thông tin chưa xác định giữ `null` hoặc ghi chú nguồn.
- `processed/units/units.jsonl`: 58.401 đơn vị; `unit_id`, `doc_id`, `parent_id`, `unit_type`, `text`, `title`, `order` cùng số Điều/Khoản/Điểm hoặc mục QCVN/phụ lục khi có. `legal_metadata` tùy chọn giữ đúng ba trường chức năng: `source_role`, `operative_clause_numbers`, `source_discrepancies`.
- `processed/meta/xrefs.jsonl`: 21.618 dẫn chiếu; `from_doc_id`, `from_so_hieu`, `from_unit_id`, các trường đích `to_*`, `evidence`, `scope`, `is_exclusion`, `in_corpus`, `downstream_use`.
- `processed/meta/relations.jsonl`: quan hệ văn bản với IDs hai đầu, `rel_type`, corpus flags và evidence/ghi chú. Loại quan hệ: `cites`, `amends`, `repeals`, `replaces`, `implements`, `consolidates`.
- `processed/penalties/penalties.jsonl`: chế tài theo `unit_id`/`penalty_id`; hành vi/đối tượng, tiền phạt, điểm GPLX, tước GPLX, tịch thu và các trường `fine_rule`, `sanction_rules` giữ căn cứ, điều kiện áp dụng.
- `processed/signs/signs_app.json`: danh mục biển theo phiên bản QCVN, nhóm/biến thể, mô tả, đơn vị nguồn, locator, trạng thái nguồn và ảnh. `signs.jsonl` là dữ liệu cho Builder. `dataset_signs/` giữ SVG theo bảy nhóm.
- `processed/eval/eval_questions.jsonl`: 71 câu đánh giá nguồn, tách khỏi dữ liệu truy xuất.
- `metadata/sources.csv`: văn bản, URL và file gốc; `metadata/corpus.json`: ngày và số bản ghi hiện tại.

`doc_id` nối các lớp dữ liệu. Ví dụ `100_2019_ND_CP::D5::K1::Pa` chỉ Điều 5, Khoản 1, Điểm a. `parent_id` quyết định cây; không suy cấu trúc hoặc đổi ID theo tên hiển thị.

## Dẫn chiếu và downstream_use

- `SAFE_EDGE` (13.106): có thể tạo cạnh sau khi kiểm endpoint, văn bản, evidence và kiểu boolean. `is_exclusion=false` tạo `citesUnit`; `true` tạo `excludesUnit`.
- `EXCLUDE_FROM_GRAPH_EDGE` (1.034): giữ bản ghi nhưng không tạo cạnh.
- `KEEP_UNRESOLVED_NO_EDGE` (5.925): chưa giải quyết được dẫn chiếu; giữ nguyên, không tạo cạnh.
- `EXTERNAL_REFERENCE_ONLY` (1.553): tham chiếu ngoài phạm vi graph; không tạo node đích giả.

`load_inputs` đọc trực tiếp corpus và kiểm ID trùng, parent/cycle, liên kết chế tài/biển và endpoint của `SAFE_EDGE`. `in_corpus=true` riêng lẻ chưa đủ tạo cạnh. Các dẫn chiếu cùng tuple được gộp, giữ evidence và locator khác nhau; số bản ghi nguồn có thể khác số cạnh graph.

## Giới hạn

Văn bản lịch sử hoặc hết hiệu lực vẫn giữ bản nguồn riêng. Ngày dataset không xác nhận hiệu lực hiện hành. Chế tài có điều kiện, nhiều đối tượng hoặc lỗi in nguồn không được rút thành một mức tiền chung; `null` không có nghĩa là 0 hay không bị phạt. `fine_rule.source_discrepancy` giữ khác biệt nguồn chưa giải quyết.

Trong `legal_metadata`, `source_role` phân biệt vai trò đoạn nguồn, `operative_clause_numbers` giữ số khoản tác nghiệp của đoạn sửa đổi, `source_discrepancies` giữ xung đột nguồn chưa giải quyết. Loader chuyển ba trường này vào `sourceRecord.origin` để Solver nhận diện chú thích và chặn kết luận khi căn cứ còn xung đột; không thay nguyên văn luật.

Ảnh biển minh họa không tự chứng minh quy định hoặc hiệu lực. Thiếu hình đúng phiên bản giữ trạng thái thiếu; không mượn hình/mô tả từ phiên bản khác. Chi tiết trường và giới hạn: [DATASHEET.md](DATASHEET.md).

Đối chiếu văn bản chính thức trước khi trích dẫn. Dataset không thay thế văn bản pháp luật hay tư vấn pháp lý.
