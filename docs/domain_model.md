# Mô hình miền pháp lý

Ba loại node:

- **LegalDocument:** văn bản thuộc whitelist, exact `doc_id`.
- **LegalUnit:** Điều/Khoản/Điểm/QCVN/QCVN_Muc/PhuLuc, exact `unit_id`.
- **TrafficSign:** occurrence theo phiên bản QCVN, exact `sign_id`; không gộp theo mã biển hoặc giữa phiên bản.

`name=id` là nhãn kỹ thuật; hiển thị title/tên/mã từ nguồn. Không trim/normalize Unicode, bỏ suffix, lấy title/order/text hash hoặc UUID thay ID. Provenance (path tương đối/file SHA-256/dòng từ 1) không phải node identity. Annotation `source_evidence` được giữ trong `sourceRecord.origin`, không thay text luật hoặc tự trở thành căn cứ trích dẫn.

## Cây đơn vị

`hasUnit` chỉ nối document tới root (`parent_id=null`); `hasChild` theo parent nguồn, hai đầu cùng document. Quyền sở hữu qua `docId` và cây.

QCVN trong unit có thể là đoạn dẫn, không tạo văn bản giả/gộp `qcvnId`/suy cây từ số mục. `order` sắp xếp, ID làm tie-break kỹ thuật; text cha lặp text con không thành hai chứng cứ độc lập.

## Mức phạt và biển báo

Penalty merge vào `penalty*` của LegalUnit theo unit_id, cardinality 1:0..1, `penalty_id=unit_id`; không node độc lập. Record thẩm quyền xử phạt không phải hành vi vi phạm, không thuộc lớp penalty; đơn vị luật nguồn vẫn giữ. `penaltySourceRecord.record` giữ `fine_rule` và `sanction_rules` với khoản nguồn, nguyên văn, phạm vi đối tượng và điều kiện áp dụng. Không đổi null thành 0/false; giữ khoảng tước GPLX min/max tháng, không lấy trung bình/suy mọi biện pháp cùng áp dụng. Không suy số tiền khi `fine_rule.source_discrepancy` chưa giải quyết. Join/cardinality/doc mismatch phải báo lỗi.

`hasSign` dùng exact unit_id của record biển; giữ mã/biến thể/tên/nhóm/mô tả/QCVN/ngày, kể cả tên rỗng. Anchor rộng chỉ ghi nhận nguồn, không khẳng định điều định nghĩa độc quyền hoặc tự reparent.

## Quan hệ pháp lý

Document nguồn → đích có `cites`, `amends`, `repeals`, `replaces`, `implements`, `consolidates`; cả IDs thuộc whitelist và corpus flags true. `replaces` giữ nghĩa thay thế, như `89_2026_ND_CP → 166_2024_ND_CP`, không mặc định là bãi bỏ toàn bộ hoặc từng unit. Không sinh thêm từ metadata, không sáng tác evidence; sửa đổi/bãi bỏ chưa đủ suy hiệu lực từng unit. Văn bản hợp nhất giữ identity riêng.

Xref chỉ tạo cạnh khi [SAFE_EDGE gate](schema.md#gate-safe_edge-bên-ngoài) hợp lệ: `is_exclusion=false` → citesUnit, true → excludesUnit. Exclusion là ngữ cảnh ngoại lệ, không khẳng định/ phủ định tuyệt đối/bãi bỏ. Giữ self-reference và mọi provenance đã duyệt.

Identity/aggregation/codec cạnh chỉ duy trì tại [schema](schema.md#identity-cạnh-và-ghi-graph).

## Phạm vi corpus graph

Whitelist cần document record, `scope != out_of_scope` và Markdown trong `processed/documents/`; loại `22_VBHN_BXD`, giữ văn bản lịch sử/superseded. Expected source counts trong [contract](../kag/schema/schema_contract.json) không phải graph counts hoặc quyền production WRITE.

Loại out_of_scope, penalties bị loại, eval và raw khỏi retrieval graph. Metadata/manifest chỉ provenance; tham chiếu ngoài corpus hoặc không SAFE_EDGE giữ ngoài graph, không placeholders. ID trùng, join sai, endpoint thiếu/lệch doc hay parent cycle phải fail closed, không sửa nguồn theo suy đoán.

Schema miền không tự bảo đảm hiệu lực hiện hành, chunking, suy luận thời gian hoặc độ chính xác anchor biển/QCVN. Phạm vi nguồn: [data](../data/README.md).
