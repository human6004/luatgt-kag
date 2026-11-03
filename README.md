# LuậtGT — Tra cứu luật giao thông và ôn thi lái xe

Ứng dụng web tiếng Việt để hỏi luật có trích dẫn, học biển báo và ôn thi lý thuyết. Người quản lý nhập, kiểm duyệt và xuất bản nội dung; quản trị viên dùng Builder để dựng đồ thị từ bộ dữ liệu nguồn (corpus) đi kèm.

## Tính năng

- **USER:** đăng ký/đăng nhập; hỏi luật, đọc nguồn và phản hồi; học biển báo, học theo chương, thi đề ngẫu nhiên hạng B và xem lịch sử.
- **ADMIN/POLICE:** nhập, kiểm duyệt, xuất bản nội dung và xử lý phản hồi chat.
- **ADMIN:** quản lý tài khoản/model; chọn project OpenSPG, chuẩn bị cấu trúc, dựng và xem kết quả graph; kiểm hạ tầng và dữ liệu đánh giá.

Một số phần giao diện còn ghi **Demo**, chỉ mô phỏng. Xem phạm vi từng chức năng trong [USER-GUIDE](docs/USER-GUIDE.md#phần-demo).

## Bắt đầu

1. [Cài đặt](docs/INSTALL.md): Git, Docker Desktop với Linux containers, Compose từ 2.20.3, cấu hình và secrets.
2. [Sử dụng](docs/USER-GUIDE.md): đăng nhập tại [WebApp](http://127.0.0.1:8081), hỏi luật, học/thi và quản lý nội dung.
3. [Dựng đồ thị](docs/runner.md): tạo project → chuẩn bị nguồn/cấu trúc → chọn phạm vi/model → kiểm sẵn sàng → dựng → xem graph.
4. [Cập nhật](docs/UPDATE.md): sao lưu, lấy bản mới và cập nhật ứng dụng, giữ dữ liệu.

Docker chạy **một project `luatgt`, 12 services, một `.env` chung**. Không cần cài Python/Java/Node trên máy người dùng.

Chưa cần KAG: xem [lifecycle WebApp riêng và FE dev với BE Docker](WebApp/README.MD#webapp-khi-chưa-chạy-kag).

**Cài mới không tự nạp nội dung, dựng graph hoặc cấu hình model.** Học/thi cần dữ liệu đã xuất bản. Builder cần project riêng và Embedding đã lưu/kiểm. Sau Build, [chọn graph phục vụ](docs/runner.md#chọn-graph-phục-vụ-truy-xuấtchat), kiểm nguồn/model rồi xác nhận kích hoạt để dùng truy xuất/Chat. Container `healthy` chưa chứng minh chatbot trả lời được.

## Công nghệ

React/TypeScript; Spring Boot/Java; Python và OpenSPG KAG. MySQL lưu nghiệp vụ và metadata OpenSPG ở hai kho riêng; Neo4j lưu graph/vector; Redis giới hạn truy cập; MinIO lưu tệp/ảnh.

## Tài liệu bảo trì

- [Docker](docker/README.md), [WebApp](WebApp/README.MD), [frontend](WebApp/frontend/README.md), [backend](WebApp/backend/README.md).
- [Kiến trúc](docs/architecture.md), [runtime](docs/runtime.md), [runner](docs/runner.md), [backend identity](docs/backend-identity.md).
- [Mô hình miền](docs/domain_model.md), [schema](docs/schema.md), [retrieval](docs/retrieval-demo.md).
- [Dữ liệu](data/README.md), [datasheet](data/DATASHEET.md), [điều kiện sử dụng](data/LICENSE.md).
- [Benchmark](benchmark/README.md), [tests](tests/README.md): phục vụ phát triển, không phải bước khởi động.

## Giới hạn sử dụng

Không thay thế văn bản chính thức hoặc tư vấn pháp lý. Nội dung trích tự động cần kiểm duyệt; trích dẫn khớp nguồn không tự xác nhận hiệu lực. Không tìm được kết quả không có nghĩa không có quy định.

Một số màn còn Demo; trang tra cứu mức phạt riêng chưa được nối vào UI. Kết quả Builder một phần không chứng minh full graph hoặc chất lượng Chat. Benchmark pháp lý chính thức chưa hoàn thành.
