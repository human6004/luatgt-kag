# Schema và codec

Schema mẫu dùng namespace **VietRoadTraffic**, ba EntityType `LegalDocument`, `LegalUnit`, `TrafficSign`. Builder `PRODUCTION` ánh xạ namespace sang project đã chọn trong RAM; không sửa file nguồn. [VietRoadTraffic.schema](../kag/schema/VietRoadTraffic.schema) và [schema_contract.json](../kag/schema/schema_contract.json) là nguồn chuẩn cấu trúc, mappings, codec và ràng buộc; không duy trì bản schema Java riêng.

`id/name` kế thừa OpenSPG Thing, `name=id`; built-in `description` không thuộc contract miền. Ngữ nghĩa nguồn/ID/cây pháp luật: [domain model](domain_model.md). SDK: [runtime](runtime.md).

## Index nội dung

VECTOR nội dung chỉ cho `LegalDocument.title`, `LegalUnit.text`, `TrafficSign.ten`, `TrafficSign.moTa`; vectorizer tạo `_title_vector`, `_text_vector`, `_ten_vector`, `_mo_ta_vector` riêng. Không tạo retrieval field gộp hoặc property miền mới. Index fulltext/hệ thống do SDK native quản lý được xem riêng trong preview, không thay bốn vector index này.

Tắt name generation cho ba EntityType và fallback `Entity.name`; không vector hóa ID/provenance/ngày/penalty, không tạo `_name_vector` giả. Null/rỗng không tạo vector; tên biển rỗng vẫn giữ mô tả. Không tự cắt text dài để qua model limit. Runtime kiểm provider/dimension/index, metadata schema không chứng minh vector đã tồn tại.

Builder lấy dimension từ model đã kiểm và đối chiếu index của project; SAMPLE giữ contract 3072 chiều/cosine. Query/retrieval của release PRODUCTION dùng namespace, dimension và model của phiên đã xác minh. Không suy tương thích model chỉ từ cùng số chiều.

## Chuẩn bị cấu trúc trên UI

Luồng thông thường là **Xem thay đổi → Chuẩn bị cấu trúc LuậtGT → Xác nhận chuẩn bị** tại Builder, theo [runner](runner.md#chọn-nơi-lưu-và-chuẩn-bị-cấu-trúc). Không yêu cầu người dùng sync schema bằng CLI hoặc tạo index thủ công.

[`structure.py`](../kag/builder/structure.py) nhận diện schema mặc định OpenSPG từ định nghĩa thực, không chỉ tên. Trên database rỗng, preview liệt kê phần xóa/giữ/thêm và index bị tác động. Có dữ liệu, loại tùy chỉnh hoặc phụ thuộc chưa rõ thì chặn thay mặc định. Apply kiểm lại quyền, physical identity, schema/dữ liệu và GraphLock; sau đó đọc lại OpenSPG/Neo4j và trạng thái ONLINE của indexes.

Đủ cấu trúc để Build và đã loại bỏ mặc định là hai kết quả khác nhau. Label tokens cũ ở sidebar Neo4j là metadata lịch sử, không chứng minh còn schema hoặc dữ liệu và không cần xóa.

## Tên và quan hệ

Logical snake_case → physical lowerCamelCase theo contract; property/predicate physical không underscore. `QCVN_Muc` là enum value.

```text
HAS_UNIT → hasUnit               LegalDocument → LegalUnit (root)
HAS_CHILD → hasChild             LegalUnit → LegalUnit
HAS_SIGN → hasSign               LegalUnit → TrafficSign
CITES_UNIT → citesUnit           LegalUnit → LegalUnit
EXCLUDES_UNIT → excludesUnit     LegalUnit → LegalUnit
CITES/AMENDS/REPEALS/REPLACES/IMPLEMENTS/CONSOLIDATES → lowerCamelCase
                                LegalDocument → LegalDocument
```

Không inverse hoặc node Penalty/Evidence/QCVN riêng.

`replaces` biểu diễn văn bản thay thế văn bản khác theo nguồn, ví dụ `89_2026_ND_CP → 166_2024_ND_CP`; không đổi thành `repeals` hoặc suy bãi bỏ từng unit. Schema hiện hành có ba EntityType và mười một predicate.

## Ngữ cảnh chế tài và nguồn

Chế tài vẫn join vào LegalUnit theo exact `unit_id`. JSON_TEXT `penalty_source_record → penaltySourceRecord` giữ toàn record và locator: `record.fine_rule` chứa khoản nguồn, nguyên văn/phạm vi mức tiền; `record.sanction_rules` giữ nguồn và điều kiện của từng chế tài. Scalar chỉ dùng khi diễn đạt được đúng phạm vi, không đổi null thành 0 hoặc mặc định mọi chế tài cùng áp dụng. `fine_rule.source_discrepancy` chưa giải quyết không cho phép suy số tiền từ giá trị chuẩn hóa cũ.

`sourceRecord.origin.source_discrepancies` giữ cờ nguồn vướng ở cả đơn vị trực tiếp và Điều/Khoản chứa. Solver đọc metadata này và abstain câu trả lời áp dụng luật; yêu cầu trích nội dung văn bản vẫn có thể trả nguyên nguồn với nhãn chưa xác nhận hiệu lực. Không sửa text legacy thành một mức tiền tự đính chính.

`source_evidence` của record nguồn được giữ trong `source_record.origin → sourceRecord.origin`, bên cạnh locator Builder. Annotation này không thay ID, text luật hoặc căn cứ trích dẫn. Giữ metadata nguồn không tự chứng minh Solver đã có đủ toàn văn các khoản chế tài liên quan.

## Nhóm và biến thể biển báo

`TrafficSign` có bốn thuộc tính Text optional: `record_type → recordType`, `description_scope → descriptionScope`, `verification_status → verificationStatus`, `parent_sign_id → parentSignId`. Schema giữ ba EntityType, mười một predicate và `PhuLuc`; không thêm cạnh để suy luật từ nhóm.

`family` là bản ghi danh mục nhóm, `variant` là biến thể có cha đã ghi rõ cùng QCVN, `standalone` có quy định độc lập, `unverified_code` chưa xác định được mã độc lập. Cha có thể là nhóm hoặc biển gốc có quy định riêng như P.127; liên kết danh mục không truyền điều kiện pháp lý xuống con. Chọn tập nhỏ giữ cả bản ghi cha trong giới hạn đã chọn.

`specific` có nội dung riêng cho mã; `family_shared` chỉ có quy định chung; `contextual` chỉ cung cấp ngữ cảnh; `unverified` chưa đủ căn cứ. Solver và bước xác minh citation chỉ dùng hàng mới có `verified_pdf`, đúng QCVN và đúng phạm vi câu hỏi. Câu hỏi nhóm dùng nguồn nhóm; mô tả chung không đủ để trả chi tiết riêng của biến thể. Retrieval neo theo mã/QCVN trong snapshot và theo `parent_sign_id` đã lưu, không tự đoán cha từ hậu tố.

Master và nguồn gốc giữ trong [`signs_app.json`](../data/processed/signs/signs_app.json); `sourceRecord.origin.record` mang metadata, locator PDF, quyết định rà, mô tả hình, `image_path`, trạng thái và provenance ảnh tới graph/release. Đường dẫn ảnh chính tương đối với repo, trỏ SVG trong `data/processed/signs/dataset_signs/` theo bảy nhóm. `signs.jsonl` sinh từ master bằng converter hiện có; thiếu SVG phù hợp để `image_path=null` và `image_status=missing`. `image_provenance` giữ nguồn hình, attribution/license và phạm vi ví dụ; ảnh xác minh đúng phiên bản không tự nâng `verificationStatus` pháp lý. `legal_description` là text dẫn xuất từ PDF có ghi cách chuẩn hóa và đoạn nguồn; `visual_description` hoặc SVG chưa được xác minh không trở thành quote pháp luật. WebApp giữ metadata khi nhập nội dung, nhưng ảnh thư viện dùng media PNG/JPEG được tải riêng. Xem [giới hạn dataset](../data/DATASHEET.md).

Release legacy thiếu bốn thuộc tính giữ ngữ nghĩa legacy, không tự gắn loại hoặc trạng thái đã xác minh. Thuộc tính optional không làm schema hash mới tương thích với release cũ: không apply schema này lên graph đang phục vụ; xem [chuyển phiên bản](runner.md#bộ-biển-báo-và-chuyển-phiên-bản).

## Codec

- Text giữ nguyên; Integer chỉ `type(value) is int`, từ chối bool/string/float. NativeIntegerKGWriter phục hồi int sau normalizer upstream trước serialization; không parse Text giống số.
- Boolean lưu Text `"true"/"false"`; JSON_TEXT là canonical JSON (`ensure_ascii=False`, `sort_keys=True`, `separators=(",", ":")`), giữ list order, encode đúng một lần; không Text[]/MultiValue.
- Bỏ null/missing khỏi payload, không literal `"null"`; giữ 0/false/chuỗi rỗng và provenance phân biệt null/missing.
- Đọc bỏ đúng một outer JSON storage layer, giữ id/vectors; JSON_TEXT thêm semantic decode. Integer vẫn native int kể cả 0; chặn double encoding/Text giống số.
- Required dùng NotNull cho properties khai báo, không thêm NotNull cho id/name kế thừa. Server constraints là DECLARATIVE_ONLY; Builder phải kiểm required fields và unitType theo contract.

Cạnh giữ sourceRecord; cạnh văn bản thêm evidence/note, xref thêm evidenceRecords/classificationProvenance. Gộp canonical JSON chỉ dedup records giống hệt, sort theo UTF-8, không mất evidence khác nhau. Implementation: [`kag/builder/`](../kag/builder/).

## Gate SAFE_EDGE bên ngoài

[`xref_contract`](../kag/schema/schema_contract.json) pin xrefs/ledger hashes, counts và policy; inputs canonical ở [`artifacts/inputs/xref-a3g2/`](../artifacts/inputs/xref-a3g2/). Config cấp path, không dùng workspace cá nhân.

Fingerprint SHA-256 canonical JSON dùng đủ 13 trường record nguồn, kể cả `from_so_hieu`, không trim/normalize hoặc đổi missing/null/rỗng. Số dòng chỉ locator. Kiểm byte hashes, full join 1:1 không mơ hồ, exact counts; chỉ SAFE_EDGE có evidence, endpoints thuộc whitelist, doc IDs khớp và `in_corpus=true` đi tiếp.

Thiếu ledger/mismatch/conflict chặn xref; không thêm downstream_use vào nguồn. Record count khác unique edge count sau gộp.

## Identity cạnh và ghi graph

Application edge key = SHA-256 canonical JSON list `[fully_qualified_from_type, from_id, physical_predicate, fully_qualified_to_type, to_id]`, type đầy đủ theo namespace của kế hoạch (ví dụ `VietRoadTraffic.<EntityType>`), IDs nguyên trạng. Evidence ngoài identity; citation/exclusion khác predicate. Key dùng dedup/tái lập, không điều khiển uniqueness server.

Server identity là **(node nguồn, predicate, node đích)**, properties **LAST_WRITE_WINS**. Builder gộp provenance trước rồi ghi đầy đủ properties cuối; ghi từng evidence sẽ mất records. Ghi mọi node thật trước cạnh, không dựa implicit endpoint creation.

`runtime_contract` bind schema hash/kiểu/text capacity, không cấp scope/quyền ghi. [Runner](runner.md#config) và [backend identity](backend-identity.md#writer-và-lock) giữ gate vận hành; [tests/schema](../tests/schema/README.md) chỉ kiểm parser/contract offline.
