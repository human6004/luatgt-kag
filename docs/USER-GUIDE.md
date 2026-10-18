# Sử dụng LuậtGT

Mở [WebApp](http://127.0.0.1:8081) hoặc địa chỉ người vận hành cấp. Cài hệ thống theo [INSTALL](INSTALL.md); nâng phiên bản theo [UPDATE](UPDATE.md).

## Đăng nhập

**Bước 1:** USER mới chọn **Chưa có tài khoản? Đăng ký**, điền họ tên, email và mật khẩu 12 ký tự trở lên, tối đa 72 byte.

**Bước 2:** chọn **Tạo tài khoản** hoặc đăng nhập bằng tài khoản có sẵn. ADMIN do người vận hành cấp, không có đăng ký ADMIN công khai.

Kết quả: USER vào chat, ADMIN vào tổng quan. Phiên hết hạn thì đăng nhập lại; đăng xuất qua menu tài khoản. Không chia sẻ mật khẩu/token.

## USER — Hỏi luật

**Bước 1:** mở **Trò chuyện với trợ lý**, nhập câu hỏi tối đa 4.000 ký tự rồi chọn **Gửi**/Enter; Shift+Enter xuống dòng. Mỗi lượt độc lập, lịch sử không tự thành ngữ cảnh lượt sau.

**Bước 2:** đọc câu trả lời và bấm mã trích dẫn → **Đối chiếu chi tiết nguồn**. Kết quả hiển thị nguyên văn đơn vị nguồn đã xuất bản. Trích dẫn khớp nguồn chưa xác nhận hiệu lực hiện hành; đối chiếu văn bản chính thức trước khi áp dụng.

**Bước 3:** chọn mục lịch sử để đọc lại; phản hồi **Hữu ích**, `WRONG`, `NO_BASIS` hoặc `OUTDATED` để ADMIN xem. Backend lưu phản hồi. **Tạo lại** chỉ điền câu hỏi vào ô nhập, cần Gửi để hỏi lại; ghim chỉ giữ trong phiên giao diện.

**Dừng chờ** không chắc dừng backend: tải lại lịch sử trước khi gửi lại. **Cuộc trò chuyện mới** không xóa lịch sử.

- Thiếu căn cứ: chatbot từ chối trả lời; không suy ra quy định không tồn tại.
- Dịch vụ lỗi/chưa sẵn sàng: người vận hành cần kiểm graph/provider/kết nối; đây không phải kết luận thiếu luật.
- Chat hiện chỉ tích hợp trích dẫn đơn vị văn bản; kết quả document/biển báo của KAG chưa biểu diễn đầy đủ qua API chat.

## USER — Tra cứu và học biển báo

**Bước 1:** tại **Tra cứu mức phạt**, chọn phương tiện, nhập hành vi và lọc tình tiết; hoặc tại **Thư viện biển báo**, tìm theo mã/tên/nhóm.

**Bước 2:** chọn **Xem chi tiết** hoặc thẻ biển để đọc nội dung, nguồn và thông tin áp dụng. **Hỏi Chatbot KAG về biển này** chỉ mở câu hỏi điền sẵn; cần Gửi và chatbot sẵn sàng.

Kết quả lấy từ nội dung đã xuất bản. Danh sách rỗng không khẳng định không có quy định. Liên kết mức phạt theo từng biển hiện chưa được nạp.

## USER — Ôn và thi thử

**Bước 1:** mở **Ôn thi theo chương**, chọn **Tiếp tục học/Ôn tập lại**. Chọn một phương án để backend chấm ngay, đọc giải thích rồi **Câu tiếp theo**. Kết quả và tiến độ được lưu; chương rỗng cần ADMIN nhập/duyệt câu hỏi.

**Bước 2:** tại `/exam`, chọn **B → Đề ngẫu nhiên → Bắt đầu thi**. Backend cần đủ câu đã xuất bản. Cấu hình luyện tập: **30 câu, 20 phút, đạt từ 27 câu đúng và không sai/bỏ trống câu điểm liệt**; không tự cập nhật quy định và không thay kỳ sát hạch chính thức.

**Bước 3:** chọn đáp án, điều hướng theo số câu, **Nộp bài** và xác nhận; hết giờ server kiểm thời hạn. Xem điểm và **Lịch sử thi**; mục **Bài thi server** là bài thật.

## ADMIN — Nội dung

**Bước 1 — Nhập bản nháp:** mở trang Văn bản, Đơn vị pháp lý, Câu hỏi hoặc Biển báo; chọn thêm/sửa, điền mã nguồn và các trường bắt buộc, rồi lưu. Văn bản nhận PDF; ảnh nhận PNG/JPEG. Giữ mã nguồn và đúng cây đơn vị/văn bản.

**Bước 2 — Kiểm duyệt:** đối chiếu nguồn, nội dung và ngày áp dụng; câu hỏi cần kiểm đáp án, điểm liệt và ảnh. Lưu xác nhận kiểm duyệt.

**Bước 3 — Xuất bản:** chọn **Duyệt/Xuất bản** hoặc **Duyệt và xuất bản các câu đã chọn**; chỉ chọn bản ghi thật đã kiểm. Ngừng xuất bản bằng nút tương ứng. Kết quả: USER thấy nội dung đủ điều kiện. Xuất bản WebApp **không tự cập nhật graph KAG**; nguồn chatbot phải khớp bộ nguồn phục vụ.

**Mức phạt:** mở trang Mức phạt → thêm/sửa → gắn văn bản/đơn vị căn cứ → nhập tiền phạt và hình thức bổ sung → xác nhận kiểm duyệt/xuất bản → **Lưu mức phạt**. Không coi mức phạt trích tự động là đã được kiểm chứng.

### Nhập nhiều bản ghi

**Bước 1:** mở **Nhập dữ liệu hàng loạt**, chọn loại dữ liệu và JSON/CSV/XLSX. Xem preview/lỗi và lựa chọn cập nhật bản ghi đã có.

**Bước 2:** chọn **Xác nhận nhập … dòng hợp lệ**. Kết quả là số thêm/cập nhật/bỏ qua, nội dung còn ở bản nháp; tiếp tục kiểm duyệt trước khi xuất bản.

**Bước 3:** với câu hỏi/biển báo, tải ZIP ảnh PNG/JPEG theo mã sau khi nhập bản ghi. Kiểm các ảnh chưa ghép được. Đáp án JSON bắt đầu từ 0; CSV/XLSX dùng 1–4. Ngân hàng nháp đi kèm: [`WebApp/docs/imports/`](../WebApp/docs/imports/).

Nhập đơn vị pháp lý dùng `/admin/content-imports?type=units`, preview rồi **Xác nhận nhập bản nháp**. Nút Nhập hàng loạt trên trang Đơn vị hiện chưa dẫn đúng loại; mở route này trực tiếp.

## ADMIN — Tài khoản và phản hồi

**Bước 1:** tại **Nhật ký chat**, đọc câu hỏi/kết quả/phản hồi, ghi chú và đánh dấu đã xử lý. Thao tác không tự hỏi lại hoặc sửa graph.

**Bước 2:** tại **Người dùng**, tìm USER và bật/khóa trạng thái. Backend lưu thay đổi theo quyền quản trị.

## ADMIN — KAG và hạ tầng

**Bước 1 — Kết nối:** từ **Đóng gói Docker**, đọc **Trạng thái dịch vụ · API thật**, mở **Kết nối KAG & truy xuất evidence** rồi **Kiểm tra lại**. Kết quả là kết nối storage và readiness query/retrieval/vector; `ALIVE` khác `READY`.

**Bước 2 — Graph/schema:** ở Graph chọn **VietRoadTraffic · SAMPLE thật** để tìm node/quan hệ. Ở Cấu hình, mở **Xem bảng schema và tải contract**. Các khối thật chỉ đọc, không sửa graph/runtime.

**Bước 3 — Builder:** mở **Dựng đồ thị**, theo [5 bước sử dụng](runner.md#dựng-đồ-thị-qua-5-bước): Dữ liệu → Cấu hình → Sẵn sàng → Đang dựng → Kết quả. Tạo Knowledge Base riêng trong OpenSPG, chọn project trên LuậtGT, **Xem thay đổi → Chuẩn bị cấu trúc LuậtGT → Xác nhận chuẩn bị**. Lưu Embedding/phạm vi/batch/hạn mức, kiểm sẵn sàng rồi chủ động xác nhận dựng. Bảng tiến trình đọc ledger; **Dừng an toàn** đợi batch/checkpoint, **Tiếp tục dựng** giữ phiên cũ. Refresh không gửi lại Build. **Xem đồ thị** mở số đã xác minh đúng run/target, kèm **Mở Neo4j** đúng database và truy vấn chỉ đọc có giới hạn. Chưa tự kích hoạt Chat. Worker chưa đủ hạ tầng vẫn chặn; khóa hoặc lần ghi chưa rõ kết quả xử lý theo [runner](runner.md#resume-trạng-thái-và-lock).

**Bước 4 — Truy xuất:** ở Hạ tầng, nhập **Nội dung truy xuất**, chọn 1–10 kết quả và tùy chọn mở rộng graph rồi **Chạy thử truy xuất**. Văn bản cũng có **Thử truy vấn · Retrieval thật**. Kết quả chỉ là nguồn/điểm/quan hệ, chưa phải kết luận luật; có thể tốn phí embedding, chỉ chạy trong phạm vi được cấp.

**Bước 5 — Đánh giá:** ở Benchmark đọc **Artifact KAG · API thật** và metrics đã đo; chưa đo hiển thị **Chưa đo**. Benchmark chính thức chưa hoàn thành.

Builder hỗ trợ **Toàn bộ dữ liệu** hoặc **Một phần dữ liệu** theo số lượng/tỷ lệ; **Xem trước phạm vi** hiển thị counts theo loại trước khi lưu. Hạn mức request không thay thế phạm vi nguồn. Chuyển sang toàn corpus giữ nguyên hạn mức người dùng đã đặt.

Muốn dựng lại: **Dừng an toàn → Đã dừng an toàn → Bỏ phiên** chấm dứt Resume và giữ graph/checkpoint. **Xóa dữ liệu để dựng lại** là thao tác riêng, xóa toàn database chuyên dụng được deployment cấp quyền sau preview và nhập đúng tên xác nhận. Giữ schema/index và lịch sử; không có rollback nguyên tử. Đích dùng chung/serving hoặc chưa được cấp quyền bị chặn. Xóa xong phải cấu hình và kiểm sẵn sàng cho phiên mới; không tự Build. Chi tiết: [Dừng, bỏ phiên và dựng lại](runner.md#dừng-bỏ-phiên-và-dựng-lại).

## Phần Demo

Các khối/nút ghi **Demo** dùng dữ liệu hoặc thao tác mô phỏng, không xác nhận backend thành công; nội dung luật mẫu chưa được xác minh:

- Chat: đính kèm ảnh, sinh câu luyện tập; học: `+10 câu`, gợi ý thông minh.
- Thi: hạng khác B, đề cố định và ôn câu sai; kết quả mẫu giữ ở trình duyệt.
- Nội dung: dán URL, trích xuất/reindex/archive/delete; sinh hoặc xóa câu hỏi.
- Người dùng: mời, đổi vai trò, đặt lại mật khẩu, xóa.
- Graph: namespace khác SAMPLE thật, Cypher, export/restore/checksum.
- Cấu hình/Docker: form model, YAML, Build/Pack/ZIP; không cấu hình provider hay triển khai hệ thống.
- Benchmark: Run/Smoke và cột HybridRAG/NativeRAG.

Cài mới cần dữ liệu được duyệt và [graph/provider đã chuẩn bị](../docker/README.md#cấu-hình-chatbot); container healthy không đủ để dùng chatbot.
