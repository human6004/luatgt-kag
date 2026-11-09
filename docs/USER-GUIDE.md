# Sử dụng LuậtGT

Mở [WebApp](http://127.0.0.1:8081) hoặc địa chỉ người vận hành cấp. Cài lần đầu: [INSTALL](INSTALL.md). Nâng phiên bản: [UPDATE](UPDATE.md).

- **Người dùng (USER):** hỏi luật, học biển báo, ôn và thi thử.
- **Quản lý nội dung (ADMIN/POLICE):** nhập, kiểm duyệt, xuất bản và xử lý phản hồi.
- **Quản trị hệ thống (ADMIN):** quản lý tài khoản, model, Builder và hạ tầng.

## Đăng nhập

1. Người dùng mới chọn **Chưa có tài khoản? Đăng ký**, nhập họ tên, email và mật khẩu từ 12 ký tự, tối đa 72 byte UTF-8.
2. Bấm **Tạo tài khoản**, hoặc đăng nhập bằng tài khoản có sẵn. Tài khoản quản trị do người vận hành cấp; không đăng ký ADMIN công khai.

USER vào trang chat; ADMIN vào tổng quan. Khi phiên hết hạn, đăng nhập lại. Đăng xuất qua menu tài khoản.

## USER — Hỏi luật

1. Mở **Trò chuyện với trợ lý**, nhập câu hỏi tối đa 4.000 ký tự rồi **Gửi** hoặc Enter. Shift+Enter để xuống dòng.
2. Đọc câu trả lời; bấm mã trích dẫn để mở **Đối chiếu chi tiết nguồn**. Chat từ dataset giữ nguyên văn và thông tin nguồn của đồ thị tại thời điểm trả lời, kể cả sau khi đổi graph. Lịch sử cũ dùng nguồn WebApp vẫn giữ cách đối chiếu cũ.
3. Bấm **Hữu ích**, `WRONG` (sai nội dung), `NO_BASIS` (thiếu căn cứ) hoặc `OUTDATED` (lỗi thời) để gửi phản hồi. Thông báo **Đã lưu phản hồi** xác nhận đã lưu; chọn mục lịch sử để đọc lại.

Mỗi lượt hỏi độc lập; lịch sử chưa tự trở thành ngữ cảnh cho lượt sau. **Tạo lại** chỉ điền câu hỏi vào ô nhập, cần **Gửi** để hỏi lại. **Cuộc trò chuyện mới** không xóa lịch sử; ghim chỉ giữ trong phiên giao diện.

Trong lúc **Đang trả lời**, bấm **Dừng**. Giao diện chờ server xác nhận rồi hiện **Đã dừng trả lời**; lịch sử giữ trạng thái đã dừng, không thêm đáp án hoặc trích dẫn muộn. Nếu lượt hỏi đã hoàn tất trước thao tác Dừng, kết quả đã hoàn tất được giữ.

Tải lại trang hoặc mất mạng không xác nhận bạn đã bấm Dừng. Tải lại lịch sử để kiểm tra trước khi hỏi lại. Việc hủy kết nối không bảo đảm provider ngừng xử lý hoặc ngừng tính phí cho request đã nhận.

- Chatbot từ chối vì thiếu căn cứ: chưa đủ nguồn để kết luận, không có nghĩa quy định không tồn tại.
- Dịch vụ lỗi/chưa sẵn sàng: nhờ người vận hành kiểm hệ thống; không coi là kết luận pháp lý.
- Trích dẫn khớp nguồn chưa xác nhận hiệu lực hiện hành. Đối chiếu văn bản chính thức trước khi áp dụng.

Chat hiện chỉ biểu diễn đầy đủ trích dẫn đơn vị văn bản; kết quả cấp văn bản/biển báo của KAG còn bị giới hạn bởi API chat.

## USER — Học biển báo

1. Mở **Thư viện biển báo**, tìm theo mã, tên hoặc nhóm.
2. Chọn thẻ biển để đọc nội dung và nguồn.
3. **Hỏi Chatbot KAG về biển này** mở câu hỏi điền sẵn; cần **Gửi** và chatbot đã sẵn sàng.

Danh sách lấy từ nội dung đã xuất bản. Danh sách rỗng không khẳng định không có quy định. UI hiện chưa có trang tra cứu mức phạt riêng; liên kết mức phạt theo biển chưa được nạp.

## USER — Ôn và thi thử

**Bước 1:** mở **Ôn thi theo chương**, chọn bộ câu hỏi rồi **Tiếp tục học/Ôn tập lại**. Chọn một phương án để backend chấm ngay, đọc giải thích rồi **Câu tiếp theo**. Kết quả và tiến độ được lưu; chương rỗng cần ADMIN nhập/duyệt câu hỏi.

**Bước 2:** tại `/exam`, chọn bộ, hạng và quy tắc đang hiệu lực rồi **Bắt đầu thi**. Số câu, thời gian, ngưỡng đạt và điều kiện điểm liệt lấy từ cấu hình đã duyệt. Backend chỉ dùng câu đã xuất bản trong đúng bộ. Thi thử không thay kỳ sát hạch chính thức.

**Bước 3:** chọn đáp án, điều hướng theo số câu, **Nộp bài** và xác nhận; hết giờ server kiểm thời hạn. Xem điểm, lời giải, lọc câu sai và **Lịch sử thi**; bài cũ có thể mở lại bằng **Xem bài**.


## ADMIN/POLICE — Nội dung

### Nhập, kiểm duyệt và xuất bản

1. Mở **Nội dung luật**, **Đơn vị pháp lý**, **Ngân hàng câu hỏi** hoặc **Biển báo**; thêm/sửa bản nháp, giữ đúng mã nguồn và cây văn bản/đơn vị. Tệp văn bản nhận PDF; ảnh nhận PNG/JPEG.
2. Đối chiếu nguồn, nội dung, ngày áp dụng; với câu hỏi, kiểm thêm đáp án, điểm liệt và ảnh. Lưu xác nhận kiểm duyệt.
3. Chọn **Duyệt/Xuất bản** hoặc **Duyệt và xuất bản các câu đã chọn**. Chỉ xuất bản bản ghi đã kiểm; dùng nút ngừng xuất bản khi cần gỡ khỏi phạm vi người dùng thấy.

Xuất bản trên WebApp không tự cập nhật graph KAG. Nguồn chatbot phải khớp bộ nguồn phục vụ đã cấu hình.

### Nhập nhiều bản ghi

1. Với câu hỏi, vào **Ngân hàng câu hỏi → Bộ câu hỏi và quy tắc đề thi** để tạo bộ riêng cho 250 và 600 câu. Ngày ban hành/hiệu lực chưa xác minh có thể để trống. Mở **Nhập hàng loạt**, chọn loại dữ liệu và bộ đích trước khi chọn JSON/CSV/XLSX; xem trước dòng hợp lệ/lỗi và chọn có cập nhật mã đã tồn tại hay không. Hai bộ có thể cùng mã nguồn `Q001` mà không ghi đè nhau.
2. Với đơn vị pháp lý, chọn loại **Đơn vị pháp lý** trong **Nhập hàng loạt**. Nhập văn bản nguồn trước; `doc_id` phải khớp văn bản đã có và đơn vị cha phải thuộc cùng văn bản. Xem trước dữ liệu trước khi xác nhận.
3. Chọn **Xác nhận nhập bản nháp**. Kết quả báo số thêm/cập nhật/bỏ qua; bản ghi được lưu ở dạng nháp và cần kiểm duyệt trước khi xuất bản.
4. Với câu hỏi/biển báo, ghép ZIP ảnh PNG/JPEG theo mã sau khi nhập bản ghi rồi kiểm ảnh chưa ghép được. Câu hỏi ghép ảnh vào bộ đã chọn; biển báo ghép ảnh trong màn nhập. Đáp án JSON bắt đầu từ 0; CSV/XLSX dùng 1–4. Ngân hàng nháp đi kèm: [250 câu](../WebApp/docs/250/) và [600 câu](../WebApp/docs/600/); mỗi bộ 250/600 có `questions-draft.json` và `question-images.zip`.
5. Nhập quy tắc đề theo hạng, bộ và thời kỳ trong **Ngân hàng câu hỏi**. Sáu quota là số câu thường từng chương; cộng số câu điểm liệt phải bằng tổng câu. Không tự lấy quy tắc hạng B áp dụng cho A/A1. Muốn đổi thời kỳ, kết thúc hiệu lực quy tắc cũ vào ngày tương lai và tạo quy tắc mới từ ngày đó; điểm bài cũ không bị chấm lại.

Câu/đáp án đã có lượt luyện hoặc thi được giữ nguyên theo phiên bản. Khi sửa nội dung đó, chọn bộ mới trong màn chỉnh sửa trước khi xuất bản. Lượt luyện lưu phương án đã chọn và phiên bản câu; tiến độ được lọc theo bộ. Dữ liệu thi/luyện cũ vẫn đọc được, không tự suy đoán phương án mà lịch sử cũ không lưu.

### Xử lý phản hồi chat

**Bước 1:** tại **Nhật ký chat**, chỉ đọc những lượt hỏi được người dùng báo **Câu trả lời sai**, **Thiếu căn cứ** hoặc **Thông tin lỗi thời**; ghi chú và đánh dấu đã xử lý. Chat chưa được báo cáo và phản hồi **Hữu ích** không hiển thị cho ADMIN/POLICE. Lịch sử riêng vẫn được giữ cho chính người dùng. Thao tác không tự hỏi lại hoặc sửa graph.

## ADMIN — Tài khoản

Mở **Người dùng**, tìm tài khoản rồi đổi vai trò **Người học/Cảnh sát** hoặc bật/khóa trạng thái. Thay đổi được lưu ở backend; đổi quyền thu hồi phiên cũ, người đó cần đăng nhập lại.

Tài khoản ADMIN dùng cơ chế khởi tạo riêng, không đổi vai trò/khóa tại đây. **Mời người dùng**, **Đặt lại MK** và **Xoá** đang phát triển; bấm chỉ hiện thông báo **Chức năng đang phát triển**, chưa thay đổi tài khoản server.

## ADMIN — KAG và hạ tầng

### Cấu hình model

Mở **Chatbot → Model & API key**. Chat và Embedding có cấu hình độc lập; giao diện phân biệt đã lưu, kết quả kiểm kết nối và bản đang dùng:

1. Chọn **Provider / API type**, điền **Base URL**, **Tên model** và **API key**. Hiện hỗ trợ OpenAI-compatible; provider/proxy do Base URL quyết định, không bắt buộc EvelProxy.
2. Bấm **Lưu Chat** hoặc **Lưu Embedding**. Sau lần đầu, để trống API key để giữ key đã lưu; nhập key mới để thay. Lưu không gọi model hoặc tự áp dụng vào Chat.
3. Bấm **Kiểm tra Chat/Embedding**, đọc hộp xác nhận rồi **Xác nhận** nếu chấp nhận phí. Ứng dụng gửi tối đa một request kiểm ngắn, chờ trong ngân sách cấu hình; không tự retry/fallback. Proxy/provider có thể thử lại nội bộ theo chính sách của hệ thống đang dùng.
4. Nếu cần đổi model phục vụ Chat, dùng **Áp dụng Chat/Embedding** sau khi kiểm thành công. Thao tác chỉ được phép khi hệ thống không bận và graph tương thích với bộ dữ liệu đã đóng gói để phục vụ Chat (release). Thiếu release hoặc vector không khớp thì bị chặn, không tự dựng lại graph.

Builder chỉ cần Embedding đã **lưu và kiểm thành công**, không cần áp dụng cho Chat. Catalog model OpenSPG vẫn độc lập; [runner](runner.md#thêm-embedding-cho-openspg) hướng dẫn điền cho việc tạo Knowledge Base.

Base URL là địa chỉ gốc của API OpenAI-compatible, thường kết thúc bằng `/v1`. Ứng dụng gọi Chat Completions với `messages`, nhận nội dung chữ từ `choices[].message.content`; Embedding dùng `/embeddings` và phải khớp model/chiều vector của graph. API có giao thức riêng cần tích hợp riêng. LuậtGT không quản lý hay chuyển tài khoản bên trong proxy, không cần EvelProxy hoặc binary đã vá; có thể dùng API trực tiếp được mạng triển khai cho phép hoặc proxy tùy chọn.

Lưu lỗi thì đọc thông báo và giữ bản đang soạn; chỉ coi là đã lưu khi UI xác nhận. Model/endpoint chưa được mạng triển khai cho phép cần người vận hành kiểm [chính sách kết nối model](../docker/README.md#provider-cho-openspg). Test thành công chưa chứng minh model phù hợp graph hoặc chất lượng trả lời luật.

### Mặc định truy xuất cho Chat

Trong **Chatbot → Đồ thị → Tùy chọn tìm kiếm**, chỉnh **Số kết quả nguồn** từ 1–10 và **Tìm thêm nội dung liên quan**. **Lưu** giữ cấu hình, **Áp dụng** dùng cho các lượt Chat tiếp theo, **Khôi phục** dùng bản trước. Bản chỉ lưu chưa tự có hiệu lực; khởi động lại vẫn giữ bản đang áp dụng.

### Builder và xem graph

Mở **Dữ liệu nguồn → Bộ dữ liệu** để xem văn bản, đơn vị pháp lý, biển báo và quan hệ đi kèm. Trang chỉ đọc, phân trang, không tạo kế hoạch hoặc yêu cầu duyệt lại nguồn. **Schema & quan hệ** hiển thị cấu trúc LuậtGT đóng gói.

Mở **Đồ thị của tôi → Dựng mới**, theo [hướng dẫn Builder](runner.md): tạo project → chuẩn bị nguồn/cấu trúc → chọn phạm vi/model → kiểm kỹ thuật → dựng → xem kết quả. Stop/Resume và bảo vệ dữ liệu giữ nguyên. Kết quả Builder có đường về đúng project/phiên.

Muốn dùng một đồ thị đã dựng cho Chat:

1. Chọn **Project đang xem** và **Phiên dựng**; đọc phạm vi một phần/toàn bộ, số liệu tại **Tổng quan**. Xem graph B không đổi Chat đang dùng A.
2. Nếu muốn, mở **Thử truy xuất**, nhập câu hỏi và gửi. Thao tác chỉ tìm nguồn trong đúng project/phiên đang chọn, có thể tính phí Embedding; không tạo câu trả lời hoặc đổi active. Không bắt buộc thử hoặc chạy benchmark trước khi áp dụng.
3. Mở **Dùng cho Chat → Dùng cho Chat**. Hệ thống tự kiểm graph, nguồn và model. Đọc đồ thị cũ/mới rồi bấm **Xác nhận dùng cho Chat**. Thiếu model thì **Chỉnh model**, lưu/kiểm kết nối rồi **Về đồ thị đang chọn**.
4. Sau khi backend xác nhận **Đang dùng**, bấm **Mở trang Hỏi luật**. Mỗi câu hỏi dùng graph/model/nguồn của lựa chọn đang áp dụng; thiếu căn cứ thì không kết luận, lỗi dịch vụ thì báo chưa khả dụng.

Nhánh dataset mới không phụ thuộc nhập/xuất bản lại corpus vào MySQL. Trích dẫn phải khớp snapshot của graph; nguồn thiếu/hỏng không được thay bằng nội dung model. Release legacy vẫn giữ chính sách nguồn WebApp cũ; xem trước và xác nhận lại một phiên Builder hợp lệ để dùng contract dataset mới. Việc nâng cấp phần mềm không tự chuyển graph hoặc viết lại release cũ. **Quản lý nội dung → Văn bản/Đơn vị pháp lý** giữ nghiệp vụ riêng.

Chuyển thất bại giữ graph cũ. Mất phản hồi thì **Tải lại** trạng thái trước khi thử lại. Chi tiết runtime, revision, fingerprint và JSON nằm trong **Chi tiết kỹ thuật**. Xem [hướng dẫn chọn graph](runner.md#chọn-graph-phục-vụ-truy-xuấtchat).

### Chia sẻ đồ thị

Mở **Chatbot → Đồ thị**, chọn phiên đã dựng PASS thuộc project của bạn rồi **Xuất gói**. Chép ZIP từ thư mục hiển thị sang thư mục `graph-packages` của máy nhận; không upload/download bằng trình duyệt. Gói chỉ chứa vector và provenance cần dựng lại, không chứa database hoặc thông tin kết nối/bí mật của máy xuất.

Ở thẻ **Nhập**, tải lại danh sách và đọc ✓/✗ cùng lý do. Gói phải cùng phiên bản dữ liệu nguồn, provider/model và số chiều với Embedding đã cấu hình. Chọn project/database **mới, trống**, chọn đúng phạm vi của gói rồi chọn **Dùng gói đã nhập** tại Bước ②. **Lưu cấu hình dựng** chỉ lưu lựa chọn; **Kiểm tra và chuẩn bị** mới nhập gói trong nền. Sau khi kiểm sẵn sàng, tự bấm **Dựng** như bình thường. Chế độ này tái sử dụng vector, không gọi API Embedding; các kiểm nguồn/provenance, khóa và bảo vệ graph đang phục vụ Chat giữ nguyên. Dựng xong chưa tự đổi graph dùng cho Chat.

### Kiểm kết nối và thử truy xuất

1. Mở **Kết nối & chẩn đoán → Kiểm tra lại**. Kết nối API được chưa chứng minh khả năng trả lời luật.
2. Thử graph đang chọn tại **Đồ thị của tôi → Thử truy xuất**. Công cụ thử graph đang phục vụ vẫn có trong phần nâng cao của trang chẩn đoán.
3. Đọc nguồn, điểm và quan hệ được trả về. Đây chưa phải kết luận luật và không đổi mặc định Chat.

Ở **Benchmark**, khối **Artifact KAG · API thật** chỉ đọc số liệu đã đo; **Chưa đo** nghĩa là chưa có số liệu. Bộ đánh giá pháp lý chính thức chưa hoàn thành.

## Chức năng đang phát triển

Các nút có nhãn **Đang phát triển** chỉ hiện thông báo **Chức năng đang phát triển**, chưa thực hiện thao tác:

- Chat: đính kèm ảnh.
- Nội dung: **Dán đường dẫn**, **Lưu trữ**, **Xoá**, **Trích xuất tự động**; khối **Pipeline xử lý tự động** đang phát triển.
- Câu hỏi: **Sinh câu hỏi từ KAG**, **Xoá**.
- Người dùng và nhật ký chat: **Mời người dùng**, **Đặt lại MK**, **Xoá**, **Chạy lại**.
- Tổng quan: **Chạy bộ kiểm thử**. Benchmark: **Chạy smoke**; khối Smoke đang phát triển.

Nhập, kiểm duyệt, xuất bản, thi theo cấu hình server, cấu hình model và Builder dùng API backend; các thao tác được xác nhận có thể thay đổi dữ liệu hoặc phát sinh phí.

Cài mới cần dữ liệu được duyệt và [graph/provider đã chuẩn bị](../docker/README.md#cấu-hình-chatbot); container healthy không đủ để dùng chatbot.
