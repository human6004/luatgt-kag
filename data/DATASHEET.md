# Thông tin dataset

**Tên:** Vietnamese Road Traffic Legal Dataset. **Ngôn ngữ:** tiếng Việt. **Mục đích:** tra cứu pháp luật giao thông đường bộ, biểu diễn graph và đánh giá truy xuất.

## Nguồn và cấu trúc

[sources.csv](metadata/sources.csv) ghi URL Công báo/CDN chính thức và file gốc. [documents.jsonl](processed/meta/documents.jsonl) chứa danh mục 91 văn bản và metadata pháp lý. [corpus.json](metadata/corpus.json) ghi ngày, số lượng bản ghi; ngày này không phải kết luận hiệu lực pháp luật.

[README](README.md#các-file-dữ-liệu) mô tả đầy đủ file và trường: Markdown toàn văn; units có ID/cây/text; relations giữa văn bản; xrefs có evidence, endpoint, polarity và `downstream_use`; penalties giữ căn cứ/điều kiện chế tài; signs theo đúng phiên bản QCVN. Dữ liệu câu hỏi đánh giá nằm riêng, không làm nguồn luật.

`downstream_use=SAFE_EDGE` cho phép tạo cạnh khi endpoint và evidence hợp lệ. `EXCLUDE_FROM_GRAPH_EDGE`, `KEEP_UNRESOLVED_NO_EDGE`, `EXTERNAL_REFERENCE_ONLY` giữ thông tin nguồn nhưng không sinh cạnh. Không suy endpoint từ ID gần giống hoặc tự gộp phiên bản văn bản.

Units có thể mang `legal_metadata` với đúng ba trường: `source_role` (vai trò đoạn nguồn), `operative_clause_numbers` (số khoản tác nghiệp), `source_discrepancies` (xung đột nguồn). Giá trị nguồn được giữ nguyên; Builder ánh xạ vào `sourceRecord.origin` cho xử lý pháp lý của Solver. Trường này không thay ID, cây hoặc text luật.

## Biển báo QCVN 41

`signs_app.json` giữ `sign_id`, `sign_code`, `qcvn`, `category`, `name`, `unit_id`, `legal_description`, `record_type`, `description_scope`, `verification_status`, quan hệ nhóm/biến thể và metadata ảnh/nguồn. `signs.jsonl` chuyển sang trường Builder bằng `convert_signs` trong `kag/builder/inputs.py`.

`record_type` phân biệt `family`, `variant`, `standalone`, `unverified_code`. `description_scope` phân biệt quy định riêng, quy định chung, ngữ cảnh và chưa xác định. `verification_status` phân biệt `verified_pdf`, `source_conflict`, `reference_only`, `review_required`. Nhóm cha không tự truyền điều kiện pháp luật xuống mọi biến thể. Hậu tố số do ứng dụng dùng không tự trở thành mã độc lập của QCVN.

`source_evidence` của biển giữ đoạn trích và locator nguồn. `image_path` tương đối tới SVG trong bảy thư mục của `dataset_signs/`; `image_status`, `image_provenance` ghi nguồn, attribution/license, phiên bản và phạm vi minh họa. Thiếu hình phù hợp giữ `null`/`missing`. Trạng thái ảnh độc lập với trạng thái căn cứ pháp lý; không suy luật từ tên file hoặc hình gần giống.

Những xung đột mã/caption trong nguồn như R.412/R.413, I.445c/I.447c, I.453c/IE.453c và P.103/P.103a được giữ trong record tương ứng. Không tự đính chính khi thiếu căn cứ. Nội dung nhóm W.211 và biến thể giữ đúng phiên bản 2019/2024.

WebApp nhập nội dung vào bản nháp riêng; ảnh media PNG/JPEG được tải riêng. SVG dataset không tự xuất bản lên WebApp. Thay dataset không thay graph hoặc release đang phục vụ.

## Chế tài và giới hạn pháp lý

`penalties.jsonl` gắn mỗi chế tài vào exact `unit_id`. `fine_rule` giữ khoản nguồn, nguyên văn tiền và phạm vi đối tượng; `sanction_rules` giữ điều kiện của từng chế tài. Không đổi `null` thành 0/false, không mặc định các biện pháp luôn áp dụng đồng thời.

Các literal tiền bất thường trong Nghị định 100/2019 và 123/2021 giữ nguyên nội dung nguồn; `fine_rule.source_discrepancy` ghi khác biệt chưa giải quyết. Không suy mức tiền từ số chuẩn hóa trước đó hoặc tự sửa nguyên văn.

Text trích tự động có thể sai OCR, ký tự, bảng và phụ lục. Văn bản hợp nhất không có hiệu lực độc lập; phải xét văn bản gốc/sửa đổi và hiệu lực từng phần. Corpus giữ văn bản lịch sử; chưa bảo đảm bao phủ mọi văn bản hoặc tình huống.

71 câu hỏi đánh giá nguồn không phải bằng chứng chất lượng trả lời hay benchmark chính thức. Truy xuất được nguồn chưa chứng minh câu trả lời áp dụng luật đúng. Đối chiếu `source_url` và bản gốc trước khi trích dẫn. Điều kiện sử dụng: [LICENSE.md](LICENSE.md).
