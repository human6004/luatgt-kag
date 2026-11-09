# Enums và cấu trúc dữ liệu biển báo (`signs_app_english_keys.json`)

## 1. Mục đích và phạm vi

- `signs_app_english_keys.json`: **887 bản ghi**, gồm QCVN 41:2019 và QCVN 41:2024. Một mã biển trùng nhau giữa các phiên bản vẫn là **hai bản ghi pháp lý khác nhau**; phân biệt bằng cặp (`qcvn`, `sign_code`). Trường `sign_id` đã bị xóa khỏi dữ liệu ứng dụng.
- Có thể lọc theo `qcvn = "QCVN 41:2024/BGTVT"` để lấy **446 bản ghi** thuộc phiên bản 2024. Việc lọc này không tự khẳng định tình trạng hiệu lực của các sửa đổi phát sinh sau đó.
- `signs_chuan_hoa.json` (tệp nguồn gốc được tài liệu trước đề cập): dùng để đối chiếu dữ liệu cũ, dòng Markdown, diễn giải nguồn và lý do cần kiểm tra. JSON ứng dụng không thay thế hồ sơ kiểm toán.
- **Chưa đối chiếu ảnh trong bước này.** Vì vậy `image_id` của tất cả bản ghi là `null`; tuyệt đối không hiểu `image_required: true` thành “đã có hình”. Trường `visual_description` hiện là chuỗi rỗng `""` ở tất cả bản ghi, cần bổ sung từ hình ảnh đã được xác minh.

## 2. Danh sách đầy đủ 16 trường

| Trường | Kiểu | Option/giá trị hợp lệ | Mục đích |
|---|---|---|---|
| `sign_code` | `string` | Mã biển thực tế, ví dụ `DP.127c`; không phải enum cố định | Tra cứu mã và ghép ảnh. Kết hợp với `qcvn` để định danh duy nhất qua các phiên bản. |
| `category` | `string` (enum) | Xem mục 3.1 | Nhóm chức năng biển báo; giá trị hiện tại vẫn bằng tiếng Việt. |
| `name` | `string` | Văn bản tự do; có thể `""` nếu nguồn chưa xác minh | Tên để tìm kiếm và hiển thị. Không tự suy đoán tên còn thiếu. |
| `visual_description` | `string` | Văn bản tự do; hiện tất cả là `""` | Mô tả đặc điểm có thể quan sát trên hình biển, giúp phân biệt từng biến thể; **không được coi là nội dung nguyên văn quy chuẩn**. |
| `legal_description` | `string` | Văn bản tự do; giữ nguyên nội dung trường `mo_ta` trước đây | Diễn giải/quy định được trích xuất từ dữ liệu nguồn. Có thể lẫn ngữ cảnh ở bản ghi `review_required`; cần kiểm tra nguồn trước khi viện dẫn pháp lý. |
| `qcvn` | `string` (enum trong dữ liệu hiện tại) | Xem mục 3.2 | Phiên bản quy chuẩn. |
| `record_type` | `string` (enum) | Xem mục 3.3 | Phân biệt họ biển, biển độc lập và biến thể. |
| `parent_code` | `string \| null` | Mã biển mẹ cùng QCVN; hoặc `null` | Chỉ đặt đối với biến thể có quan hệ mã mẹ được ghi nhận. |
| `children_codes` | `string[]` | Mảng mã con trong cùng QCVN, hoặc `[]` | Liệt kê biến thể; có thể có cả ở `standalone` nếu mã độc lập vẫn có biến thể liên quan. |
| `description_scope` | `string` (enum) | Xem mục 3.4 | Cho biết phạm vi và độ cụ thể của `legal_description` (không phản ánh độ tin cậy của `visual_description`). |
| `unit_id` | `string` | ID đơn vị văn bản KAG hiện có; không phải enum cố định | Liên kết lại dữ liệu pháp lý. Có thể bao quát cả chương/mục, **không thay thế trích dẫn chính xác từng đoạn**. |
| `image_required` | `boolean \| null` | `true`, `false`, `null` | Có cần hình riêng cho bản ghi này không; `null` là chưa kết luận. |
| `image_id` | `string \| null` | ID ảnh hợp lệ trong kho ảnh, hoặc `null` | Chưa có dữ liệu ảnh đối chiếu nên hiện tất cả đều `null`. Không tự tạo ID. |
| `image_status` | `string` (enum) | Xem mục 3.5 | Trạng thái đối chiếu và liên kết ảnh. |
| `verification_status` | `string` (enum) | Xem mục 3.6 | Mức độ kiểm chứng **thông tin văn bản** (khác với kiểm chứng ảnh). |
| `note` | `string[]` | Mảng ghi chú tự do hoặc `[]` | Chỉ giữ lưu ý có giá trị; đã bỏ các ghi chú lặp khuôn mẫu có thể đọc từ các trường khác. |

**Quy ước chung:** Tên trường tiếng Anh `snake_case`; mã enum kỹ thuật dùng chữ thường `snake_case`, riêng giá trị `category` và `qcvn` giữ chuỗi đúng như dữ liệu nguồn. `null` là giá trị JSON thực, **không phải** chuỗi `"null"`. Mảng rỗng dùng `[]`, không dùng chuỗi rỗng; riêng `visual_description` chưa có thông tin thì dùng `""`.

**Định danh sau khi bỏ `sign_id`:** dùng khóa ghép (`qcvn`, `sign_code`) trong cơ sở dữ liệu. Nếu một hệ thống cần khóa đơn riêng, tạo ở lớp lưu trữ, không thêm lại `sign_id` vào tệp JSON này.

## 3. Enum cụ thể

### 3.1. `category` — 7 giá trị hiện có

| Giá trị chính xác | Ý nghĩa |
|---|---|
| `Biển chỉ dẫn` | Biển chỉ dẫn |
| `Biển báo nguy hiểm và cảnh báo` | Biển cảnh báo nguy hiểm |
| `Biển hiệu lệnh` | Biển hiệu lệnh |
| `Biển báo cấm` | Biển cấm |
| `Biển chỉ dẫn trên đường cao tốc` | Biển chỉ dẫn trên đường cao tốc |
| `Biển phụ` | Biển phụ |
| `Biển hết cấm` | Biển báo hết cấm |

Tên trường đã chuyển thành `category`, nhưng **giá trị enum vẫn giữ nguyên bằng tiếng Việt** như trong nguồn; nếu sau này đổi giá trị phải có bước chuyển đổi dữ liệu, tránh làm hỏng bộ lọc.

### 3.2. `qcvn` — 2 giá trị hiện có

- `QCVN 41:2024/BGTVT` — 446 bản ghi.
- `QCVN 41:2019/BGTVT` — 441 bản ghi.

### 3.3. `record_type`

| Enum | Ý nghĩa | Ảnh riêng |
|---|---|---|
| `family` | Mã mẹ chỉ đại diện cho một họ biển, không có biển độc lập riêng. | Thông thường `image_required = false`. |
| `variant` | Mã con thuộc một mã mẹ, ví dụ `DP.127c`. | Thường cần hình riêng. |
| `standalone` | Mã có định nghĩa là biển độc lập hoặc là mã mẹ nhưng có biển độc lập riêng. **Có thể vẫn có `children_codes`** như `I.408`. | Thường cần hình riêng. |
| `unverified_code` | Mã hiện chưa xác nhận được là biển hợp lệ độc lập từ nguồn Markdown. | Để `image_required = null` khi chưa rõ. |

`family` và `standalone` **không thể phân biệt chỉ bằng việc có hậu tố a/b/c hay không**. Không xóa `standalone` chỉ vì nó cũng có mã con.

### 3.4. `description_scope`

| Enum | Ý nghĩa | Khi dùng để tìm ngữ nghĩa |
|---|---|---|
| `specific` | Nội dung từ đoạn định nghĩa/mục hoặc dòng liệt kê tương ứng với biển. **Không đảm bảo mô tả chỉ nhắc duy nhất mã này.** | Có thể lập chỉ mục nếu độ tin cậy phù hợp. |
| `family_shared` | Nội dung mang ý nghĩa chung của cả họ biển hoặc được kế thừa từ họ. | Ưu tiên lập chỉ mục **một lần trên mã mẹ**; lấy mã con sau. |
| `contextual` | Nội dung lấy từ ngữ cảnh kề cận hoặc tiểu nhóm, chưa hoàn toàn độc lập. | Không dùng riêng để quyết định một biến thể nếu không có bằng chứng khác. |
| `unverified` | Mô tả chưa cô lập hoặc có mâu thuẫn/chưa đủ căn cứ. | Nên loại khỏi chỉ mục dùng để trả lời tự động cho tới khi kiểm tra. |

Các giá trị `description_scope` phân loại phạm vi **`legal_description`** (không phải `visual_description`). Đây là phân loại rút gọn dựa trên `description_source_basis` của JSON gốc, **không phải lần kiểm chứng mới với PDF**.

### 3.5. `image_required` và `image_status`

**`image_required` (JSON boolean ba trạng thái):**

- `true`: Cần đối chiếu một hình riêng cho bản ghi.
- `false`: Không yêu cầu hình riêng (thường là mã họ biển/ mã mẹ).
- `null`: Chưa đủ căn cứ xác định yêu cầu hình riêng.

**`image_status` (enum):**

| Enum | Ý nghĩa | Quy tắc |
|---|---|---|
| `not_checked` | Chưa đối chiếu với kho ảnh. | Giá trị khởi tạo khi `image_required = true`. |
| `not_applicable` | Không cần ảnh riêng. | Giá trị khởi tạo khi `image_required = false`. |
| `needs_review` | Chưa quyết định được yêu cầu ảnh. | Giá trị khởi tạo khi `image_required = null`. |
| `verified` | Đã tìm được ảnh **và xác minh đúng mã + biến thể + phiên bản liên quan**. | Chỉ đặt khi có bằng chứng và `image_id` hợp lệ. |
| `missing` | Đã đối chiếu kho ảnh nhưng chưa có ảnh phù hợp. | Không được gán chỉ vì `image_id = null`. |
| `mismatch` | Có ảnh ứng viên nhưng sai mã/hình/biến thể hoặc không khớp nguồn. | Cần rà soát trước khi hiển thị. |

Lưu ý `image_id` không phải đường dẫn tải ảnh; backend quản lý kho ảnh nên tự phân giải `image_id` ra file/URL. Nếu chưa có kho ảnh, giữ `null`.

### 3.6. `verification_status`

| Enum | Nhãn giao diện gợi ý | Ý nghĩa chính xác |
|---|---|---|
| `matched_md` | Đã đối chiếu MD | Mã/tên/mô tả đã được ghép với nguồn Markdown theo quy tắc kiểm tra hiện có. **Không có nghĩa đã đối chiếu PDF/hình gốc.** |
| `derived_from_md` | Suy ra từ MD | Tên/nội dung được diễn giải từ các đoạn Markdown thay vì lấy nguyên văn nhan đề; cần thận trọng khi coi là tên chính thức. |
| `review_required` | Cần xác minh | Có xung đột, mô tả lẫn, mã không rõ hoặc lỗi cần rà soát. |
| `verified_pdf` | Đã xác minh PDF | **Dành cho tương lai**, chỉ dùng sau khi có đối chiếu thành công với PDF nguồn gốc đúng phiên bản và ghi nhận bằng chứng. Chưa có bản ghi nào ở trạng thái này trong bộ xuất hiện tại. |
| `not_checked` | Chưa kiểm tra | **Dành cho dữ liệu bổ sung về sau** chưa qua quá trình đối chiếu. Không có bản ghi nào ở trạng thái này trong bộ xuất hiện tại. |

Không chuyển `matched_md` thành `verified_pdf` hoặc `verified` chỉ vì mã được tìm thấy trong Markdown. `verification_status` kiểm tra **thông tin biển**, còn `image_status` kiểm tra **ảnh**.

## 4. Quy tắc cho Chat/KAG và trang tra cứu

1. **Tìm mã cụ thể:** lookup chính xác theo cặp (`qcvn`, `sign_code`); không cần embedding để đoán mã. Nếu chỉ có `sign_code`, phải xác định hoặc lọc phiên bản `qcvn` trước khi chọn bản ghi.
2. **Tìm theo hình vẽ:** khi đã có dữ liệu, tìm ngữ nghĩa từ `name` + `visual_description` để phân biệt biến thể. Hiện `visual_description` rỗng ở cả 887 bản ghi, **chưa được sử dụng làm cơ sở nhận dạng** và không nên nhúng các chuỗi rỗng vào vector.
3. **Tìm theo ý nghĩa pháp lý:** tìm từ `name` + `legal_description` kết hợp metadata `record_type`, `description_scope`, `verification_status`. Không nhúng nguyên `note`, `unit_id` hoặc mã nguồn kiểm toán. Với `family_shared`, ưu tiên lập chỉ mục nội dung chung **một lần ở họ biển**, sau đó liên kết sang biến thể.
4. **Tìm kiếm kết hợp:** xác định biển từ mã/hình vẽ, rồi lấy `legal_description` của chính biển hoặc họ biển liên quan trong **cùng `qcvn`**. Không để đoạn mô tả hình vẽ thay thế căn cứ pháp lý.
5. **Kết quả là họ biển:** xem `children_codes` để đưa ra các biến thể phù hợp; chỉ quyết định đúng một biến thể khi có mô tả hình vẽ hoặc bằng chứng đáng tin cậy phân biệt.
6. **Trả hình:** chỉ hiển thị hình mang tính xác nhận khi `image_status = verified` và `image_id != null`. Nếu chưa có hình, hiển thị thông báo chưa xác minh thay vì tự gắn ảnh.
7. **Văn bản cần kiểm tra:** với `verification_status = review_required` hoặc `description_scope = unverified`, không đưa ra khẳng định pháp lý chắc chắn chỉ dựa trên bản ghi đó. Tra lại nguồn gốc trước.
8. **Trích dẫn pháp lý:** `unit_id` giúp tra cứu đơn vị nguồn; để đưa ra dẫn chứng chính xác phải dùng vị trí nguồn chi tiết trong `signs_chuan_hoa.json` hoặc nội dung Markdown/PDF tương ứng.
9. **Phiên bản và liên kết:** mặc định giao diện có thể lọc bộ 2024 theo dữ liệu đang có; các truy vấn lịch sử cần chỉ rõ QCVN. `parent_code` và `children_codes` luôn được diễn giải trong cùng phiên bản `qcvn`; không dùng riêng `sign_code` làm ID duy nhất qua các năm.

## 5. Những thuộc tính đã chuyển ra khỏi JSON ứng dụng

- Metadata quản trị nguồn: `doc_id`, `so_hieu`, `ngay_hieu_luc`, `ngay_het_hieu_luc` (có thể tra cứu qua bản đầy đủ khi cần).
- Trường đã loại khỏi JSON ứng dụng: `sign_id`; các trường trùng/chỉ dành cho parser ở nguồn gốc gồm `bien_phu_variant`, `code_base`, `code_suffix`, `variant_code`, `record_type_rationale`.
- Bằng chứng kiểm toán: `name_source_basis`, `description_source_basis`, `source_location`, `description_source_location`, `review_reasons`, `original_extraction`.
- Phần `note` chỉ bỏ **6 mẫu ghi chú lặp đã có thể đọc từ trạng thái/kiểu dữ liệu**; các ghi chú cụ thể liên quan mâu thuẫn hoặc thiếu căn cứ vẫn giữ lại.

Các tên trường như `bien_phu_variant` hay `description_source_basis` trong mục này là **tên metadata của nguồn gốc**, không phải trường tiếng Việt còn tồn tại trong JSON ứng dụng. Việc đổi tên chỉ áp dụng cho các khóa của `signs_app_english_keys.json`.

## 6. Ví dụ bản ghi `DP.127c` (trích từ `signs_app_english_keys.json`)

```json
{
  "sign_code": "DP.127c",
  "category": "Biển hết cấm",
  "name": "Biển hết tốc độ tối đa cho phép theo biển ghép",
  "visual_description": "",
  "legal_description": "a) Đến hết đoạn đường tốc độ tối đa cho phép theo biển ghép số P.127b, P.127c, đặt biển số DP.127 “Biển hết tốc độ tối đa cho phép theo biển ghép” tương ứng với các phương án tổ chức giao thông. Trường hợp \"Hết tất cả các lệnh cấm\" đặt biển số DP.135. b) Biển có giá trị báo cho người tham gia giao thông biết hiệu lực của biển số P.127(b,c) hết tác dụng. Kể từ biển này, các xe được phép chạy với tốc độ tối đa đã quy định trong Luật Đường bộ và Luật Trật tự, an toàn giao thông đường bộ. Biển số DP.127a Biển số DP.127b Biển số DP.127c",
  "qcvn": "QCVN 41:2024/BGTVT",
  "record_type": "variant",
  "parent_code": "DP.127",
  "children_codes": [],
  "description_scope": "family_shared",
  "unit_id": "51_2024_TT_BGTVT::QCVN41_2024_BGTVT::D84",
  "image_required": true,
  "image_id": null,
  "image_status": "not_checked",
  "verification_status": "matched_md",
  "note": []
}
```

`visual_description: ""` nghĩa là chưa có mô tả đặc điểm hình biển, **không có nghĩa ảnh đã được xác minh**. `legal_description` giữ nguyên dữ liệu pháp lý được trích xuất trước đó; muốn dùng để trích dẫn chính thức vẫn phải kiểm tra nguồn tương ứng.

## 7. Thống kê sau khi rút gọn

| Hạng mục | Số lượng |
|---|---:|
| Tổng số bản ghi | 887 |
| Mã mẹ `family` | 123 |
| Biến thể `variant` | 502 |
| Độc lập `standalone` | 260 |
| Mã chưa xác minh `unverified_code` | 2 |
| `matched_md` | 664 |
| `derived_from_md` | 96 |
| `review_required` | 127 |
| Ảnh `not_checked` | 723 |
| Ảnh `not_applicable` | 123 |
| Ảnh `needs_review` | 41 |
| Bản ghi còn ghi chú cụ thể | 186 |

**Quy tắc quản lý:** file rút gọn chỉ phục vụ chạy ứng dụng; mọi chỉnh sửa dữ liệu pháp lý lâu dài nên sửa trong kho dữ liệu chuẩn, sau đó xuất lại JSON ứng dụng để không phân kỳ bản dữ liệu. Khi bổ sung `visual_description`, cần mô tả đúng hình của từng `sign_code` và ghi nhận căn cứ kiểm tra riêng.
