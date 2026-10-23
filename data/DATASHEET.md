# Thông tin dataset

**Tên:** Vietnamese Road Traffic Legal Dataset. **Ngôn ngữ:** tiếng Việt. **Mục đích:** chuẩn hóa pháp luật giao thông đường bộ cho truy xuất, graph và đánh giá.

## Nguồn và cấu trúc

Văn bản pháp luật lấy từ Công báo Chính phủ và CDN đi kèm. `raw/` giữ PDF/HTML/DOC nguồn; `processed/` giữ Markdown, units, quan hệ, tham chiếu, mức phạt và biển báo. URL từng văn bản ở [sources.csv](metadata/sources.csv), danh mục/phạm vi ở [document_inventory.csv](metadata/document_inventory.csv).

[README dữ liệu](README.md) mô tả từng thư mục, ID và cách dùng xrefs.

## Snapshot corpus

[corpus.json](metadata/corpus.json) ghi `dataset_date=2026-10-23`; [checksums.json](metadata/checksums.json) giữ SHA-256. Ngày snapshot không phải kết luận hiệu lực pháp luật.

Số lượng từng loại dữ liệu được trình bày tại [Thống kê corpus](README.md#thống-kê-corpus), đối chiếu với metadata của snapshot.

`22_VBHN_BXD` được lưu trong `processed/out_of_scope/`, không thuộc corpus chính. `processed/eval/` giữ 71 câu đánh giá nguồn, không thuộc nguồn truy xuất và chưa là benchmark chính thức.

Snapshot mô tả dữ liệu đã lưu; không xác nhận mọi văn bản đang có hiệu lực hoặc corpus bao phủ mọi thay đổi pháp luật.

## Biển báo QCVN 41

[`processed/signs/signs_app.json`](processed/signs/signs_app.json) là nguồn bảo trì chuẩn, hợp nhất 2.653 lần xuất hiện gốc thành 907 ID: giữ 887 ID main và thêm 20 ID; 24 ID vắng trong app tester vẫn được giữ. Mỗi hàng giữ các bản gốc, Git ref/path/vị trí, quyết định rà và locator nguồn. [`signs.jsonl`](processed/signs/signs.jsonl) là đầu vào Builder dẫn xuất bằng `kag.builder.inputs.convert_signs`; join unit/document để lấy văn bản và ngày, không suy hiệu lực từ năm QCVN. Counts và quan hệ hiện hành được ghi theo snapshot corpus, tách khỏi trạng thái kiểm chứng biển báo.

Đối soát dùng [QCVN 41:2019 trên Công báo](https://congbao.chinhphu.vn/van-ban/thong-tu-so-54-2019-tt-bgtvt-30665/30015.htm) và [PDF QCVN 41:2024](https://datafiles.chinhphu.vn/cpp/files/vbpq/2024/11/51-bgtvt-kem.pdf), đúng từng phiên bản. Có 833 hàng `verified_pdf` về text/mã/locus, 44 hàng `source_conflict` và 30 hàng `reference_only`. Khớp text và đọc mẫu hình không phải chứng thực pháp lý toàn corpus. `source_evidence` giữ text trích và locator PDF; mô tả dùng các đoạn tương ứng, bỏ running header/caption và chuẩn hóa khoảng trắng, không tự đính chính từ ngữ nguồn. Các khoản quy định sau hình, như 51.4.2/47.4.2 của IE.453c, được giữ riêng; đoạn nêu rõ mã hoặc cặp mã có thể dùng làm mô tả riêng, không mặc định mọi biến thể chỉ có luật chung.

Các điểm chưa giải quyết: D.15 có heading/caption R.412(i–p) khác văn xuôi R.413(i–p); E.50 có I.445c khác caption I.447c; caption I.453c khác IE.453c trong quy định. Bản 2019 còn có heading/caption P.103a và W.239a khác mã gốc không hậu tố trong văn xuôi B.3/C.39. Chưa có nguồn đính chính trong các nguồn đã tra; không hợp nhất hoặc đổi mã theo ghi chú không có căn cứ. DP.127d và một số mã trích từ tham chiếu không được coi là định nghĩa độc lập. Bản 2019 có W.211a/b; bản 2024 C.11 chỉ định W.211. Hai ID W.211a/b năm 2024 vẫn giữ với ngữ cảnh W.211 và trạng thái tham chiếu, không mượn mô tả năm 2019.

Có 127 nhóm, 486 biến thể, 246 biển độc lập và 48 mã chưa xác minh độc lập; mỗi hàng phân biệt mô tả riêng/chung/ngữ cảnh. Hậu tố số như P.127-80, I.448-1, IE.469-1 là ID ứng dụng, không phải mã độc lập do PDF định danh. Không suy luật riêng hoặc hiệu lực từ ảnh, hậu tố hay nhóm cha.

[`dataset_signs/`](processed/signs/dataset_signs/) giữ 351 SVG ảnh chính, chia bảy thư mục `01_bien_cam`, `02_bien_nguy_hiem`, `03_bien_hieu_lenh`, `04_bien_chi_dan`, `05_bien_phu`, `06_bien_het_cam`, `07_bien_cao_toc`. Đã bỏ 716 PNG khỏi dataset. Đã dọn 387 SVG nguồn cũ khỏi `reference-images/` sau backup; ảnh hiện hành chỉ nằm trong bảy nhóm. Git ref/path/blob gốc và các quyết định ảnh trước vẫn nằm trong provenance, không đổi thành đường dẫn mới.

907 hàng có 681 ảnh `verified` ở mức minh họa, 70 `missing`, 156 `not_applicable`. `image_provenance` ghi hash SVG thật, nguồn SVG, attribution/license, locator hình chính thức đúng năm, phạm vi ví dụ và giới hạn. `verified` ở đây là đối chiếu nội dung hình/caption theo nguồn đã đọc; không chứng nhận quy cách sản xuất biển, không nâng trạng thái pháp lý. Công báo2019 đơn sắc chưa chứng minh màu từ bản PDF đó. Trường `image_review.svg_migration.previous_primary` giữ metadata ảnh trước khi chuyển, kể cả đường dẫn PNG lịch sử.

DP.127a/b/c đã thay bằng SVG có đúng gạch kết thúc theo B.27d của cả hai năm; không dùng ba SVG tester trùng byte với P.127a/b/c. I.427b và IE.463a/b/c có hai SVG riêng năm 2019/2024 vì chữ trong hình thay đổi. IE.471 chỉ có SVG phù hợp năm 2019; bản ứng viên 2024 nhúng PNG nên không được chọn, hàng 2024 để `missing`. Không suy khác năm từ crop hoặc lựa chọn ví dụ.

17 biến thể 2019 trước đây chưa liên kết hình đã được đặt `image_required=true`: IE.457b, IE.460a/b/c, IE.461a/b/c/d, IE.463a, IE.464a/b, IE.468c, IE.472a/b và W.243a/b/c. 14 hàng dùng SVG khớp; IE.460a/b/c thiếu SVG mẫu số 5/55/555. IE.467a/b đã đổi liên kết theo caption Hình26: a không có 250m, b có 250m. I.437 bỏ sáu định nghĩa raster không được tham chiếu; vector không đổi, ảnh render trước/sau giống hệt từng pixel.

I.448 dùng một ví dụ 2 km đã đối chiếu, không dùng SVG gốc thiếu chữ/QL1; ảnh này không đại diện đủ bốn ví dụ. IE.450a/b chọn một hướng trong các phương án; IE.465 chỉ minh họa hai địa điểm; IE.464a giữ đủ ba biển ví dụ. Phạm vi được ghi trong `image_provenance.scope`. W.211 năm 2024 dùng hình đầu máy từ SVG có tên W.211a, giữ nguyên ID/caption W.211. R.412p năm 2019 để thiếu ảnh do phụ lục M khác D.17/Word; vẫn giữ `source_conflict`, chưa kết luận khác hình theo năm.

70 hàng thiếu ảnh gồm các SVG sai trị số/chữ, lề hoặc tỷ lệ chưa chốt, mã chưa có hình riêng đúng phiên bản và trường hợp chưa có SVG thay thế. Có I.414c/d, I.417b, I.502, IE.456a/b/c, IE.460a/b/c, IE.470, IE.471 năm 2024, P.121, các trị số P.127 ngoài ví dụ 50, P.133/134/135, R.301a–h, R.302a/b, R.310a/b/c, R.412p năm 2019, W.211a năm 2024, W.211b cả hai năm và W.220. Xem từng hàng `image_status`, `image_provenance.limitations` và `image_review` trong master; thiếu căn cứ không đồng nghĩa hình hoặc mã chắc chắn sai.

Builder giữ `image_path` tương đối và provenance trong `sourceRecord.origin.record`. Thư viện nội dung WebApp là luồng nhập bản nháp riêng: giữ nhóm/QCVN/metadata nguồn, nhưng không tự tải file từ đường dẫn repo. Dùng chức năng tải PNG/JPEG lên media để hiển thị ảnh; SVG dataset không tự được tải lên hoặc xuất bản; luồng media hiện tại chưa nhận SVG native. Dataset đổi ảnh không tự làm UI hiển thị SVG. Nhập nội dung hoặc tải ảnh không đổi graph hay release đang phục vụ.

Khi bảo trì master, tạo lại `signs.jsonl` từ chính repo và cập nhật counts/checksums hiện hành. Snapshot/release/checkpoint đã niêm phong giữ nguyên; thay dataset không cập nhật graph đang chạy. Một lần build graph mới phải dùng quy trình Builder hiện có và xét tương thích riêng, không sửa hash pin cũ để ép khớp. Đoạn Python tối thiểu:

```python
import json
from pathlib import Path
from kag.builder.inputs import convert_signs

root = Path('.')  # chạy tại thư mục repo
def rows(path):
    return [json.loads(line) for line in (root / path).read_text(encoding='utf-8').split('\n') if line]

master = json.loads((root / 'data/processed/signs/signs_app.json').read_text(encoding='utf-8'))
units = {r['unit_id']: r for r in rows('data/processed/units/units.jsonl')}
documents = {r['doc_id']: r for r in rows('data/processed/meta/documents.jsonl')}
converted = convert_signs(master, units, documents)
(root / 'data/processed/signs/signs.jsonl').write_bytes(
    ''.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n' for r in converted).encode('utf-8'))
```

## Chế tài và câu hỏi đánh giá

`penalties.jsonl` có 1.820 chế tài theo hành vi: bỏ 164 record chỉ quy định thẩm quyền khỏi lớp penalty, giữ nguyên đơn vị luật nguồn; bổ sung 18 chế tài tịch thu chính không kèm tiền trước đây bị bỏ sót. `fine_rule` giữ khoản nguồn, phạm vi và nguyên văn mức tiền; `sanction_rules` giữ nguồn và điều kiện áp dụng các chế tài. Điều kiện, trường hợp lựa chọn và nhiều nhóm đối tượng không được gộp thành mức chung. `null` không đồng nghĩa 0, không phạt hoặc không áp dụng chế tài.

Ba record `100_2019_ND_CP::D37::K6`, `100_2019_ND_CP::D50::K1::Pa` và `100_2019_ND_CP::D50::K1::Pb` có lỗi in số tiền trong bản Công báo đã đối chiếu. `fine_rule.source_discrepancy` giữ nguyên văn, giá trị chuẩn hóa cũ và trạng thái chưa giải quyết; scalar tiền để null, không tự đính chính theo suy đoán.

Sáu LegalUnit trực tiếp hoặc chứa các record trên giữ `source_evidence.source_discrepancies`, được chuyển qua `sourceRecord.origin` để Solver không xác nhận số tiền từ text legacy của Điều/Khoản cha.

71 câu đánh giá đã được rà câu hỏi, căn cứ và gold theo đúng bản văn nguồn: 64 câu `verified`, 7 câu biển báo giữ `verified=false` vì unit gold cũ là điều tổ chức thực hiện, chưa chứng minh quy định riêng của biển. Câu theo văn bản lịch sử ghi rõ phiên bản, không lấy luật mới ghi đè ID cũ. Đây là rà dữ liệu offline, chưa chứng minh chất lượng Retrieval/Solver hoặc kết quả benchmark chính thức.

## Giới hạn và điều kiện sử dụng

- Text trích tự động có thể sai ở OCR, ký tự, bảng biểu và phụ lục; bản Công báo cũng có thể có lỗi nguồn.
- Chế tài đã được đối chiếu nguồn và kiểm nhất quán offline trong phạm vi sửa; chưa phải xác nhận pháp lý toàn bộ corpus hoặc mọi tình huống áp dụng. Ngày hiệu lực có thể áp dụng theo từng phần.
- Dẫn chiếu có thể ngoài corpus, thiếu endpoint hoặc chưa rõ ngữ nghĩa; chỉ dùng policy `SAFE_EDGE` đã kiểm.
- Dữ liệu cấu trúc và câu hỏi đánh giá là phần pipeline tạo ra, cần phân biệt với luật gốc.

Đối chiếu văn bản gốc tại `source_url` trước khi trích dẫn. Dataset không thay thế văn bản pháp luật chính thức hoặc tư vấn pháp lý. Điều kiện sử dụng và căn cứ nguồn: [LICENSE.md](LICENSE.md).
