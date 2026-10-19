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
CITES/AMENDS/REPEALS/IMPLEMENTS/CONSOLIDATES → lowerCamelCase
                                LegalDocument → LegalDocument
```

Không inverse hoặc node Penalty/Evidence/QCVN riêng.

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
