# Mô hình miền pháp lý

Ba loại node:

- **LegalDocument:** văn bản thuộc whitelist, exact `doc_id`.
- **LegalUnit:** Điều/Khoản/Điểm/QCVN/QCVN_Muc/PhuLuc/Muc/Bang/Hinh/MauBieu, exact `unit_id`. Mục, bảng, hình và mẫu biểu phải có cấu trúc hoặc caption thật trong nguồn; dùng `hasChild` và provenance hiện có, không tạo loại node/cạnh mới.
- **TrafficSign:** occurrence theo phiên bản QCVN, exact `sign_id`; không gộp theo mã biển hoặc giữa phiên bản.

`name=id` là nhãn kỹ thuật; hiển thị title/tên/mã từ nguồn. Không trim/normalize Unicode, bỏ suffix, lấy title/order/text hash hoặc UUID thay ID. Provenance (path tương đối/file SHA-256/dòng từ 1) không phải node identity.

`LegalUnit.legal_metadata` trong corpus giữ vai trò nguồn, số khoản tác nghiệp và xung đột nguồn qua `source_role`, `operative_clause_numbers`, `source_discrepancies`. Loader chuyển đúng ba trường vào `sourceRecord.origin`; Solver tiếp tục phân biệt chú thích và từ chối kết luận khi nguồn xung đột.

## Cây đơn vị

`hasUnit` chỉ nối document tới root (`parent_id=null`); `hasChild` theo parent nguồn, hai đầu cùng document. Quyền sở hữu qua `docId` và cây.

QCVN trong unit có thể là đoạn dẫn, không tạo văn bản giả/gộp `qcvnId`/suy cây từ số mục. `order` sắp xếp, ID làm tie-break kỹ thuật; text cha lặp text con không thành hai chứng cứ độc lập.

Phụ lục có thể là root `PhuLuc` của document. Thông tư 46/2024 giữ 17 phụ lục riêng, thay vì đặt nội dung biểu mẫu dưới Điều 18. Các ID trích xuất cũ vẫn giữ để bảo toàn tham chiếu; `parent_id`, kiểu và provenance hiện hành quyết định cây. Không suy mảnh trích QCVN hoặc caption hình thành một khoản quy phạm độc lập.

## Mức phạt và biển báo

Penalty merge vào `penalty*` của LegalUnit theo unit_id, cardinality 1:0..1, `penalty_id=unit_id`; không node độc lập. Record thẩm quyền xử phạt không phải hành vi vi phạm, không thuộc lớp penalty; đơn vị luật nguồn vẫn giữ. `penaltySourceRecord.record` giữ `fine_rule` và `sanction_rules` với khoản nguồn, nguyên văn, phạm vi đối tượng và điều kiện áp dụng. Không đổi null thành 0/false; giữ khoảng tước GPLX min/max tháng, không lấy trung bình/suy mọi biện pháp cùng áp dụng. Không suy số tiền khi `fine_rule.source_discrepancy` chưa giải quyết. Join/cardinality/doc mismatch phải báo lỗi.

`hasSign` dùng exact unit_id của record biển; giữ mã/biến thể/tên/nhóm/mô tả/QCVN/ngày, kể cả tên rỗng. Anchor rộng chỉ ghi nhận nguồn, không khẳng định điều định nghĩa độc quyền hoặc tự reparent.

## Quan hệ pháp lý

Document nguồn → đích có `cites`, `amends`, `repeals`, `replaces`, `implements`, `consolidates`; cả IDs thuộc whitelist và corpus flags true. `replaces` giữ nghĩa thay thế, như `89_2026_ND_CP → 166_2024_ND_CP`, không mặc định là bãi bỏ toàn bộ hoặc từng unit. Không sinh thêm từ metadata, không sáng tác evidence; sửa đổi/bãi bỏ chưa đủ suy hiệu lực từng unit. Văn bản hợp nhất giữ identity riêng.

Xref chỉ tạo cạnh khi [điều kiện SAFE_EDGE](schema.md#điều-kiện-safe_edge) hợp lệ: `is_exclusion=false` → citesUnit, true → excludesUnit. Exclusion là ngữ cảnh ngoại lệ, không khẳng định/ phủ định tuyệt đối/bãi bỏ. Giữ self-reference và mọi provenance đã duyệt.

Identity/aggregation/codec cạnh chỉ duy trì tại [schema](schema.md#identity-cạnh-và-ghi-graph).

## Phạm vi corpus graph

Corpus gồm document record và Markdown tương ứng trong `processed/documents/`; giữ văn bản lịch sử/superseded. Units giữ exact ID, text và cây parent nguồn.

Xrefs đọc `downstream_use` trực tiếp: chỉ `SAFE_EDGE` có endpoint/evidence hợp lệ mới tạo cạnh. Ba giá trị còn lại giữ record, không tạo cạnh hoặc placeholder. Eval và raw không thuộc retrieval graph. Metadata nguồn giữ URL/file gốc; locator Builder giữ đường dẫn tương đối, hash file và dòng. ID trùng, join sai, endpoint lệch doc hoặc parent cycle phải báo lỗi.

Schema miền không tự bảo đảm hiệu lực hiện hành, chunking, suy luận thời gian hoặc độ chính xác anchor biển/QCVN. Phạm vi nguồn: [data](../data/README.md).
