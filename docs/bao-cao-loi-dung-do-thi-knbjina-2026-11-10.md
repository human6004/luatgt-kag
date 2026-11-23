# Báo cáo lỗi dựng đồ thị LuậtGT KAG

**Ngày ghi nhận:** 10/11/2026  
**Đồ thị:** KnbJina — database `knbjina`  
**Trạng thái tại thời điểm kiểm tra:** Tiến trình đã kết thúc vì lỗi, chưa được khôi phục.

## 1. Hiện tượng

WebApp dừng ở bước **Ghi nội dung: 27.008/58.946**, hiển thị trạng thái **“Cần xử lý”**. Nút **Dừng** và **Tiếp tục** bị vô hiệu hóa.

Thông báo trên giao diện:

> Lần dựng trước bị gián đoạn, chưa xác định đã ghi xong. Nhờ quản trị kiểm tra trước khi tiếp tục.

Giao diện không cung cấp thao tác khôi phục, khiến quản trị viên không biết phải xử lý thế nào. Chờ thêm hoặc khởi động lại dịch vụ không làm phiên dựng tự chạy tiếp.

## 2. Tiến độ và dữ liệu đã xác nhận

| Hạng mục | Kết quả |
|---|---|
| Kiểm tra điều kiện | Hoàn tất |
| Chuẩn bị dữ liệu | Hoàn tất |
| Tạo vector | Hoàn tất 59.399/59.399 |
| Lưu vector | Hoàn tất 922/922 đợt |
| Ghi nội dung | Đã xác nhận 27.008/58.946 |
| Đợt ghi kế tiếp | 64 nội dung, chưa được xác nhận |
| Kiểm nội dung và các bước sau | Chưa thực hiện |
| Liên kết thực tế trong Neo4j | 0 |

Kiểm tra trực tiếp Neo4j xác nhận:

- Database `knbjina` có **27.008 nút**.
- **64 nội dung của đợt ghi lỗi chưa tồn tại** tại thời điểm kiểm tra.
- Truy vấn mẫu trả về 10 bản ghi có `_text_vector`, mỗi vector **1024 chiều**, đúng cấu hình.
- Kiểm tra mẫu chưa chứng minh mọi nội dung và vector đều đúng, đủ.

## 3. Lỗi kỹ thuật ghi nhận

Vào **21:58:29 ngày 10/11/2026, giờ Việt Nam**, log tiến trình dựng ghi nhận:

```text
neo4j.pool - Unable to retrieve routing information
```

Trạng thái lưu của phiên dựng:

```text
run_id: build-a1088ef5-3488-47a8-b022-b2849b8b026f
stage: write-nodes
state: ERROR
error_code: RUNTIME
done: 27008
total: 58946
```

Sổ tiến độ ghi nhận **422 đợt ghi nội dung đã xác nhận** và **1 đợt ở trạng thái INTENT**, với `graph_writes: 1`.

`INTENT` nghĩa là phần mềm đã lưu ý định/thao tác gọi ghi, chưa chứng minh thao tác đó hoàn tất tại database. Vì còn đợt chưa xác nhận, phần mềm hiển thị mã **`UNCERTAIN_WRITE`**, giữ khóa bảo vệ và không cho tiếp tục.

## 4. Nguyên nhân đã biết và phần chưa xác định

**Đã xác nhận:** tiến trình gặp lỗi lấy thông tin kết nối Neo4j và kết thúc ở bước ghi nội dung.

**Dấu hiệu liên quan đến tài nguyên:**

- Log Neo4j ghi nhận nhiều lần xử lý bị khựng gần thời điểm lỗi, có lần khoảng **11,6 giây**.
- Một lần kiểm tra kết nối sau đó mất khoảng **16 giây**.
- Tại thời điểm kiểm tra, container Neo4j dùng khoảng **1,36 GiB trên giới hạn 1,375 GiB**.
- Không ghi nhận container bị giết vì hết bộ nhớ: `OOMKilled=false`; bộ đếm OOM được kiểm tra cũng bằng 0.

**Chưa xác định:** nguyên nhân gốc khiến kết nối thất bại. Áp lực tài nguyên là khả năng cần kiểm tra thêm, chưa đủ bằng chứng kết luận lỗi do thiếu RAM.

Giới hạn RAM nói trên là giới hạn riêng của container Neo4j. Máy chủ còn RAM không đồng nghĩa container được phép sử dụng thêm.

## 5. Những vấn đề không phải nguyên nhân của lần dừng này

**Token Jina:** ảnh dashboard cho thấy đã dùng 9.729.479 trên 10.000.000 token được cấp, còn khoảng **270.521 token** theo số liệu hiển thị. Bước tạo và lưu vector đã hoàn tất trước khi lỗi ghi xảy ra.

**Model Chat chưa kiểm tra:** thông báo này liên quan đến khả năng dùng Chat, không giải thích việc dừng ghi nội dung.

**Phiên đăng nhập OpenSPG:** có thời điểm giao diện báo cần đăng nhập lại và không đọc được danh sách đồ thị. Đây là vấn đề truy cập riêng; đăng nhập lại không tự giải quyết đợt ghi chưa xác nhận.

## 6. Ảnh hưởng của việc đóng giao diện hoặc khởi động lại Docker

- Đóng tab trình duyệt không xóa dữ liệu hay tự dừng công việc phía dịch vụ.
- Dừng và chạy lại Docker bình thường giữ lại dữ liệu và tiến độ đã lưu, miễn là không xóa volumes hoặc thư mục trạng thái.
- Phiên hiện tại vẫn giữ trạng thái lỗi sau khi khởi động lại, không tự chạy tiếp.
- Restart không thay thế được việc đối chiếu và xử lý đợt ghi dở.

Không cần xóa đồ thị hoặc tạo lại vector để xử lý lỗi này.

## 7. Thiếu sót của phần mềm

1. Có cơ chế khóa khi kết quả ghi chưa rõ, nhưng chưa có luồng khôi phục hoàn chỉnh cho quản trị viên.
2. Thông báo “Cần xử lý” không giải thích cụ thể lỗi, dữ liệu đã lưu và bước tiếp theo.
3. Lỗi gốc được lưu ở dạng chung `RUNTIME`, còn giao diện hiển thị `UNCERTAIN_WRITE`, khiến người dùng khó biết lỗi bắt đầu từ đâu.
4. Có thời điểm giao diện đồng thời hiển thị “Đã xóa đồ thị”, trong khi kiểm tra thực tế vẫn có 27.008 nội dung. Thông báo này dễ gây hiểu nhầm về trạng thái hiện tại.

## 8. Hướng xử lý đề xuất — chưa thực hiện

- Xác nhận tiến trình cũ và tác vụ ghi từ xa đã ngừng.
- Xác minh đúng database, nguồn và phiên dựng trước khi khôi phục.
- Đối chiếu lại đợt chưa xác nhận ngay trước khi xử lý.
- Cho phép thử lại phần chưa ghi có kiểm soát, dùng vector đã lưu và giữ nguyên dữ liệu đã xác nhận.
- Chạy các bước kiểm nội dung, ghi liên kết và xác minh đồ thị còn lại.
- Kiểm tra độ trễ và giới hạn tài nguyên Neo4j trước khi tiếp tục phiên lớn.
- Cải thiện thông báo lỗi và cung cấp thao tác khôi phục an toàn; không chỉ bỏ khóa hoặc sửa con số tiến độ.

## 9. Phạm vi công việc đã thực hiện

Đã đọc mã xử lý liên quan, log dịch vụ, trạng thái container, sổ tiến độ và truy vấn chỉ đọc vào Neo4j. Người dùng cũng kiểm tra dữ liệu qua Neo4j Browser.

**Chưa sửa mã nguồn, chưa thay đổi giới hạn tài nguyên, chưa sửa tiến độ hoặc gỡ khóa, chưa ghi lại đợt lỗi và chưa xóa dữ liệu.**
