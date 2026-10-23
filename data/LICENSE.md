# Nguồn và điều kiện sử dụng — caoDATA

## 1. Văn bản pháp luật gốc

Toàn bộ nội dung pháp luật trong bộ dữ liệu này được lấy từ **Công báo Chính phủ**
(`congbao.chinhphu.vn`) và CDN đi kèm (`congbaocdn.chinhphu.vn`) — kênh công bố chính thức
văn bản quy phạm pháp luật của Việt Nam. Không dùng nguồn thương mại nào.

Theo **Luật Sở hữu trí tuệ (Điều 15 khoản 2)**, "văn bản quy phạm pháp luật, văn bản hành chính,
văn bản khác thuộc lĩnh vực tư pháp và bản dịch chính thức của văn bản đó" thuộc nhóm
**đối tượng không thuộc phạm vi bảo hộ quyền tác giả**.

> Đây là ghi chú về căn cứ pháp lý, không phải ý kiến tư vấn. Nếu bạn định phân phối lại
> hoặc dùng cho mục đích thương mại, hãy tự xác minh lại với luật sư — điều kiện có thể
> khác tùy cách dùng.

## 2. Phần do pipeline tạo ra

Những thứ sau **không có trong văn bản gốc**, là kết quả xử lý của các script trong repo này:

- cấu trúc cây `unit_id` / `parent_id` (`units.jsonl`)
- đồ thị quan hệ giữa văn bản (`relations.jsonl`)
- tham chiếu cấp Điều/Khoản/Điểm (`xrefs.jsonl`)
- bảng mức phạt đã ghép (`penalties.jsonl`)
- danh mục biển báo (`signs.jsonl`)
- trường ngày tháng, `scope`, và bộ câu hỏi đánh giá

Phần này do bạn (chủ repo) sở hữu và tự quyết định giấy phép. Nếu công bố, nên nêu rõ
để người dùng phân biệt được đâu là luật gốc, đâu là chú giải do máy sinh.

## 3. Cảnh báo bắt buộc đọc

**Bộ dữ liệu này không thay thế văn bản pháp luật chính thức và không phải tư vấn pháp lý.**

- Text được **trích tự động từ PDF**, vẫn có thể sai sót ở bảng biểu, phụ lục kỹ thuật
  và ký tự đặc biệt. Kết quả kiểm tra cấu trúc không thay thế đối chiếu nội dung nguồn.
- Bảng mức phạt trong `penalties.jsonl` do **regex ghép lại** từ ba chỗ rời trong nghị định.
  Đã đối chiếu thủ công một số trường hợp, **chưa kiểm 100%**.
- Trường ngày hiệu lực suy ra từ câu chữ trong văn bản và từ quan hệ thay thế; văn bản có
  hiệu lực theo giai đoạn được ghi ở `ngay_hieu_luc_bo_phan`, đọc thiếu trường này sẽ ra kết luận sai.
- Luật giao thông Việt Nam sửa đổi liên tục. Xem `DATASHEET.md` để biết dữ liệu chốt ngày nào.

**Trước khi trích dẫn cho bất kỳ mục đích thực tế nào, hãy đối chiếu bản gốc tại
`source_url` của văn bản đó trong `documents.jsonl`.**

Nếu dùng để xây dựng hệ thống tư vấn cho người dùng cuối, cần hiển thị cảnh báo tương tự
và luôn dẫn nguồn tới điều khoản cụ thể.
## 4. SVG biển báo

SVG trong `processed/signs/dataset_signs/` tái sử dụng từ tester và các file Wikimedia Commons. Hình QCVN chính thức dùng để đối chiếu mã, caption và phiên bản; Commons là nguồn file minh họa, không thay nguồn pháp lý.

Mỗi ảnh chính có `image_provenance.attribution` trong `signs_app.json`: tác giả/credit, trang Commons, URL file, giấy phép, URL giấy phép và thay đổi đã thực hiện. Metadata được giữ từ manifest nguồn tester; các mục bổ sung được đối chiếu với bytes file qua Commons imageinfo. Không suy giấy phép chỉ từ tên mã hoặc năm QCVN.

Các file được nguồn ghi Public domain hoặc CC BY-SA 4.0 theo từng mục; khi phân phối lại cần giữ attribution tương ứng. [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) áp dụng cho các SVG được ghi giấy phép đó, không tự áp dụng cho toàn corpus. I.437 có thay đổi kỹ thuật: bỏ sáu định nghĩa raster không dùng trong `defs`; vector và hình render giữ nguyên. Các SVG còn lại không sửa nét; đổi tên/đường dẫn và liên kết không đổi tác giả hoặc giấy phép.

387 SVG nguồn cũ đã được dọn khỏi repo sau backup. Attribution và Git ref/path gốc của ảnh hiện hành vẫn được giữ trong master; việc dọn bản nguồn cũ không đổi tác giả hoặc giấy phép.
