# Dựng đồ thị bằng Builder

Dành cho quản trị viên tự tạo nơi lưu graph, chọn dữ liệu và dựng đồ thị trên WebApp. Mở **Chatbot → Đồ thị** tại `/admin/chatbot`.

Builder dùng bộ dữ liệu nguồn (corpus) và cấu trúc dữ liệu (schema) đi kèm phiên bản ứng dụng; chưa hỗ trợ tải bộ nguồn tùy ý hoặc tự trích xuất tri thức từ văn bản trên UI.

Build thành công chưa tự đưa graph vào Chat. Mở **Chatbot → Đồ thị**, chọn dòng của graph, thử truy xuất nếu muốn rồi **Dùng cho Chat** và xác nhận. Chat cần model tương thích và snapshot nguồn đi cùng graph, không cần nhập lại corpus vào WebApp. Xem [chọn graph phục vụ](#chọn-graph-phục-vụ-truy-xuấtchat).

## Chuẩn bị

- Đăng nhập LuậtGT bằng tài khoản **ADMIN**.
- Có tài khoản OpenSPG sở hữu project và quyền dùng database Neo4j riêng. [Nơi lấy tài khoản](../docker/README.md#truy-cập-quản-trị-openspg-và-neo4j).
- Có API key và model Embedding được hệ thống cho phép. Embedding là dịch vụ chuyển nội dung thành vector để tìm kiếm; kiểm model và dựng graph có thể tính phí.
- Dùng cùng hostname khi mở LuậtGT và OpenSPG, ví dụ đều là `127.0.0.1`; không trộn với `localhost`.

Ví dụ xuyên suốt: tên hiển thị **Luật giao thông**, namespace **RoadLaw**, database **roadlaw**. Thay bằng tên của bạn; không chọn database đang phục vụ Chat hoặc chứa dữ liệu ngoài phạm vi quản lý.

## Bộ biển báo và chuyển phiên bản

Bộ nguồn ngày 22/10/2026 có 907 bản ghi biển báo, giữ các ID từ main và bổ sung nguồn tester đã đối soát. Có nhóm, biến thể và hàng còn xung đột/tham chiếu; không đồng nghĩa mọi hàng đủ căn cứ trả lời. Chi tiết ở [DATASHEET](../data/DATASHEET.md). Dữ liệu dẫn xuất đã đi kèm repo; cài đặt và Build thông thường không cần chạy converter hoặc kiểm thử nội bộ.

Schema mới thêm metadata biển báo và đổi schema/contract hash. Code mới chưa đọc được release được seal bằng schema cũ; giữ image cũ cho graph/Chat hiện có. Không chuẩn bị schema mới trên project có dữ liệu cũ và không tự kích hoạt release mới.

Để chuyển: dùng phiên bản mới trong stack riêng, tạo project/database rỗng riêng, chuẩn bị cấu trúc rồi Build và kiểm đọc lại trên đích mới. Người vận hành tự quyết lúc dựng toàn bộ, cập nhật các image ứng dụng và chọn **Dùng cho Chat** sau khi kiểm source, model, retrieval và citation. Giữ image/volumes/release cũ để quay lại; không sửa snapshot cũ tại chỗ. Chỉ thay source hoặc tạo plan offline chưa nạp bộ dữ liệu mới vào graph cũ.

## Tạo project trong OpenSPG

OpenSPG gọi project là **Knowledge Base**. Nếu đã có project phù hợp, chuyển đến [quy trình trên LuậtGT](#dựng-đồ-thị-qua-5-bước).

### Thêm Embedding cho OpenSPG

1. Mở [OpenSPG](http://127.0.0.1:8887/) và đăng nhập. Nếu hiện **Reset Password**, tự hoàn tất **New Password** và **Confirm Password** trước.
2. Bấm tên tài khoản góc phải → **Model Configuration → OpenAI → Add Model**. Thẻ OpenAI nhận API tương thích OpenAI; không buộc chọn nhà cung cấp OpenAI.
3. Điền các trường sau:

| Trường | Cách điền |
| --- | --- |
| Supplier Presentation Name | Tên để nhận biết dịch vụ |
| Model Type | `embedding` |
| Visible range | **Private** |
| base_url | Base URL đã được cho phép, gồm tiền tố API, ví dụ `https://<host-của-bạn>/v1`; không thêm `/embeddings` hoặc dấu `/` cuối |
| API-Key | Key của nhà cung cấp/proxy; không dùng mật khẩu Neo4j hoặc token nội bộ |
| Model | ID model Embedding chính xác do nhà cung cấp cung cấp |

**Bấm OK gửi request Embedding thật và lưu model/key vào catalog OpenSPG.** Có thể phát sinh phí; các lớp native/proxy có thể thử lại theo chính sách triển khai. Chỉ bấm khi chấp nhận tác động này. Không cần **Add Custom Field** cho cấu hình OpenAI-compatible thông thường.

Catalog OpenSPG và cấu hình model LuậtGT độc lập; key không tự đồng bộ. Tạo Knowledge Base trên UI chỉ cần Embedding, không bắt buộc Chat. Nếu endpoint bị chặn, nhờ người vận hành kiểm [chính sách provider](../docker/README.md#provider-cho-openspg).

### Tạo Knowledge Base

1. Về danh sách Knowledge Base → **Create Knowledge Base**.
2. Trong **New Knowledge Base**, điền **Chinese name of knowledge base** là tên hiển thị; **English name of knowledge base** là namespace, ví dụ `RoadLaw`. Namespace bắt đầu bằng chữ cái ASCII, chỉ gồm chữ/số/gạch dưới, tối đa 64 ký tự.
3. Chọn **Private**, **Local**. Trong **Figure Storage Configuration**, dùng URI `neo4j://openspg-neo4j:7687`, user `neo4j` và mật khẩu deployment đã cấu hình. URI mặc định chứa `release-openspg-neo4j` cần thay cho khớp Compose LuậtGT; không dùng địa chỉ localhost của Browser.
4. **database** bị khóa: hệ thống lấy namespace viết thường, ví dụ `RoadLaw` → `roadlaw`. Kiểm tên chưa trỏ tới database đang phục vụ Chat hoặc dữ liệu có sẵn không thuộc project này; không dùng hai namespace chỉ khác hoa/thường.
5. Trong **Vector configuration**, chọn model Embedding vừa thêm. Chọn ngôn ngữ từ các lựa chọn của phiên bản đang chạy.

**Save kiểm Embedding thật lần nữa và tạo/chọn database cho project.** Đọc lại tên, nơi lưu và model trước khi bấm; có thể tính phí và thay đổi dữ liệu quản trị.

Sau khi lưu, mở **Configuration** của đúng thẻ project để đối chiếu ID, namespace và database. **Modeling / Knowledge Model** hiển thị cấu trúc dữ liệu, chưa phải graph sau Build. Database rỗng ở thời điểm này là bình thường.

## Dựng đồ thị qua 5 bước

Năm bước dưới mô tả thao tác trong một hộp thoại, không phải năm tab riêng.

### 1. Chuẩn bị model và mở hộp thoại

Trong **Chatbot → Model & API key**, lưu và kiểm Embedding thành công trước khi Build. Builder dùng model đã kiểm; không cần áp dụng Embedding cho Chat trước. Kiểm kết nối và tạo vector có thể tính phí. Xem [hướng dẫn model](USER-GUIDE.md#cấu-hình-model).

Trong **Đồ thị**, bấm **+ Dựng đồ thị mới**. Hộp thoại **Dựng đồ thị mới** tự chuẩn bị nguồn và tính phạm vi. Đợi thống kê nội dung/liên kết/vector; đó là số dự kiến, chưa phải số đã ghi vào graph. Nếu nguồn lỗi, xử lý nguyên nhân rồi dùng **Tải lại dữ liệu** khi nút xuất hiện; không sửa corpus để bỏ qua kiểm tra.

### 2. Chọn đích trống

Bấm **Tải lại danh sách**, chọn project đã tạo trong trường **Đồ thị trống**. Có thể dùng **Mở OpenSPG** để đối chiếu ID, namespace và database trong Configuration của đúng project trước khi chọn. Nếu project trùng tên, xác định đúng ID tại OpenSPG trước; không chọn chỉ dựa vào tên hiển thị.

Danh sách chỉ gồm project bạn sở hữu trong phiên đăng nhập OpenSPG. Quyền ADMIN LuậtGT không thay quyền sở hữu project Private. Project đang có dữ liệu, chưa đọc được dữ liệu hoặc đang phục vụ Chat không phải đích Build mới. Không dùng database chung với project khác hoặc dữ liệu ngoài phạm vi quản lý.

### 3. Chọn phạm vi

Trong **Phạm vi**, chọn **Toàn bộ dữ liệu** hoặc **Một phần dữ liệu**. Với một phần, nhập số nguyên 1–100 ở **Tỷ lệ dữ liệu (%)**. Hệ thống tự tính lại thống kê; đợi kết quả trước khi xác nhận.

Tập một phần được chọn cố định, ưu tiên nội dung ngắn; văn bản nguồn, đơn vị cha, bản ghi cha của biến thể biển và hai đầu quan hệ đều nằm trong giới hạn. Phạm vi quá nhỏ để giữ đủ nguồn/các loại sẽ bị từ chối. Đây không phải mẫu ngẫu nhiên hoặc bảo đảm đại diện thống kê.

Batch và hạn mức request lấy từ cấu hình Builder đang lưu; hộp thoại hiện tại không có ô sửa hai giá trị này. Mặc định batch 64, hạn mức không giới hạn. Trước khi chấp nhận phí, nhờ người vận hành đối chiếu cấu hình nếu cần hạn mức riêng. Hạn mức đếm request từ ứng dụng gồm retry vectorizer, không phải giới hạn token/tốc độ và không bảo đảm số lần thử bên trong proxy/provider. Đổi phạm vi không tự bỏ hạn mức đã lưu.

### 4. Xác nhận và theo dõi

Đọc lại đích trống, phạm vi và chi phí rồi bấm **Xác nhận dựng**. Ứng dụng tự kiểm database trống, chuẩn bị cấu trúc, lưu cấu hình, kiểm sẵn sàng rồi bắt đầu dựng. Chuẩn bị cấu trúc có thể thay schema mặc định OpenSPG và tạo/tạo lại index trên đích rỗng; bước cấu trúc không gọi Embedding. Dữ liệu đã tồn tại, loại tùy chỉnh hoặc phụ thuộc chưa rõ bị chặn; không xóa mọi loại ngoài LuậtGT để vượt lỗi. Nhãn cũ có thể còn trong sidebar Neo4j do metadata lịch sử, không cần xóa label tokens.

Sau khi bắt đầu, hộp thoại đóng; theo dõi dòng graph và tiến trình dưới bảng. Trang tự cập nhật khoảng ba giây một lần. Số đã xử lý/tổng chỉ hiện khi có số liệu, không có dự đoán thời gian toàn phiên. Tải lại hoặc rời trang không dừng Worker. Lỗi một phần/mất phản hồi: dùng **Tải lại danh sách**, đọc **Chi tiết kỹ thuật**, chờ xác định kết quả trước khi thử lại; không gửi Build lặp hoặc xóa khóa.

### 5. Xem kết quả

Khi graph đã dựng xuất hiện trong bảng, bấm **Xem**. Số liệu graph hiện tại tách khỏi lịch sử ở **Chi tiết kỹ thuật phiên**; **Nguồn của lần dựng** giữ snapshot nguồn của đúng phiên. Kết quả một phần chỉ xác minh phạm vi đã chọn, chưa chứng minh toàn corpus hoặc chất lượng trả lời luật.

Có thể mở Neo4j từ màn xem graph. Nếu Browser hỏi kết nối, dùng địa chỉ Bolt và tài khoản Neo4j của deployment, mặc định `bolt://127.0.0.1:7687`. Chọn đúng database trước khi đọc; với ví dụ `roadlaw`, chạy từng lệnh:

```cypher
:use roadlaw
MATCH (n) RETURN n LIMIT 25;
MATCH (a)-[r]->(b) RETURN a,r,b LIMIT 25;
```

Thay `roadlaw` bằng database của graph. Knowledge Model là cấu trúc; graph sau Build là dữ liệu. Dựng xong chưa tự chọn graph cho Chat.

## Nhập từ gói

Tại **Chatbot → Đồ thị**, dùng **Xuất gói** trên dòng graph đã xác minh thuộc project của bạn. Chép ZIP từ thư mục được hiển thị sang thư mục `graph-packages` của máy nhận; không có upload/download ZIP qua trình duyệt.

Trên máy nhận, lưu/kiểm Embedding phù hợp rồi bấm **+ Nhập từ gói**. Trong hộp thoại **Nhập từ gói**, chọn **Đồ thị trống** và **Gói đồ thị**; dùng **Tải lại danh sách** sau khi chép ZIP. Đọc dấu tương thích và lý do lỗi. Phạm vi lấy từ gói, không chọn lại tỷ lệ. Gói phải khớp corpus, provider/model/dimension; không dùng gói không rõ nguồn.

Bấm **Xác nhận nhập** khi đã kiểm đích và phạm vi. Ứng dụng tự chuẩn bị cấu trúc, nhập/chuyển đổi replay, kiểm sẵn sàng và dựng vào đích trống. Nhập không gọi Embedding; khóa, identity, provenance/vector và xác minh vẫn bắt buộc. Không dump/load Neo4j hoặc tự chuyển Chat. Chi tiết dung lượng và quyền thư mục: [Docker](../docker/README.md#chia-sẻ-đồ-thị).

## Chọn graph phục vụ truy xuất/Chat

1. Mở **Chatbot → Đồ thị**, bấm **Xem** ở đúng dòng graph. Xem graph khác không đổi graph phục vụ Chat.
2. **Thử tìm kiếm** là tùy chọn: nhập **Câu hỏi thử**, chọn **Số kết quả nguồn** và **Tìm thêm nội dung liên quan** khi cần, rồi bấm **Thử truy xuất**. Request dùng graph đang xem, không chuyển Chat; có thể tính phí Embedding.
3. Đóng màn xem, bấm **Dùng cho Chat** ở đúng dòng graph. Hộp thoại **Dùng đồ thị cho Chat** cho biết graph cũ/mới và điều kiện còn thiếu. Endpoint/model Embedding phải khớp phiên dựng; cùng số chiều chưa đủ.
4. Thiếu model thì quay về **Model & API key**, lưu/kiểm Chat và Embedding rồi chọn lại graph. Nguồn thiếu/hỏng phải xử lý đúng snapshot/phiên, không nhập lại MySQL để vượt lỗi. **Dữ liệu nguồn KAG** không yêu cầu duyệt lại dataset.
5. Bấm **Xác nhận dùng cho Chat** khi đủ điều kiện. Chuẩn bị/xác minh và đóng gói release (seal) chạy tự động nếu cần; không có nút seal riêng. Chờ graph được đánh dấu **Đang dùng cho Chat** và hết thông báo chưa sẵn sàng. Không bắt gửi câu thử hoặc chạy benchmark.
6. Mở trang hỏi luật tại `/chat` và đối chiếu trích dẫn. Trích dẫn lưu cùng câu trả lời, giữ nguồn cũ sau khi đổi graph.

Project đang xem, đích Builder và graph phục vụ độc lập. Kích hoạt giữ lựa chọn qua restart; không chọn database đang phục vụ làm đích Build/xóa, kể cả qua project khác trỏ cùng database. Muốn quay lại graph cũ, chọn đúng graph và kiểm lại bằng cùng quy trình; không tự khôi phục dữ liệu graph cũ.

Preview cũ, graph thay đổi, thiếu quyền hoặc model/index không khớp sẽ bị chặn. Kích hoạt thất bại giữ lựa chọn cũ; mất phản hồi thì **Tải lại danh sách** trước khi thử lại. Release mới giữ source snapshot của đúng graph. Release legacy vẫn giữ kiểm publication WebApp; cập nhật phần mềm không tự viết lại hoặc chuyển release. [Chi tiết publisher legacy](../docker/README.md#publisher-nâng-cao).

## Dừng và dựng lại

### Dừng và tiếp tục

Bấm **Dừng**, chờ **Đã dừng an toàn**. Tiến độ và dữ liệu được giữ để **Tiếp tục** sau. Đóng trang hoặc dừng theo dõi log không dừng Worker.

Tiếp tục dùng cùng phiên, nguồn, đích, model, batch và hạn mức cũ; số request đã dùng không được đặt lại. Sau Worker restart, dùng **Tải lại danh sách**, kiểm thông báo rồi bấm **Tiếp tục**; UI tự kiểm sẵn sàng trước khi Resume. Nếu lần ghi bị gián đoạn và **Tiếp tục** khả dụng, xác nhận để Builder đọc lại đợt ghi dở. Nếu nguồn cần chuẩn bị lại hoặc cấu hình không còn khớp, nhờ người vận hành xử lý. Không sửa cấu hình hoặc xóa khóa để ép tiếp tục.

### Chấm dứt phiên qua API quản trị

UI hiện không có nút riêng cho thao tác `abandon`. API quản trị vẫn cho phép chấm dứt phiên đã dừng khi đủ quyền và revision hiện hành: phiên không thể tiếp tục, nhưng graph, vector, điểm lưu và lịch sử được giữ. Nhờ người vận hành nếu cần thao tác này; không dùng **Xóa** thay cho chấm dứt phiên mà giữ dữ liệu.

### Xóa dữ liệu đồ thị

**Thao tác này xóa toàn bộ node và quan hệ trong database chuyên dụng được cấp quyền, không chỉ dữ liệu của một phiên. Không có hoàn tác nguyên tử.** Chỉ dùng khi đã sao lưu và muốn làm trống đúng database đó. Không xóa database đang phục vụ Chat hoặc dùng chung; chuyển Chat sang graph khác trước.

1. Nếu Worker đang chạy, **Dừng** và chờ **Đã dừng an toàn**. Nhờ người vận hành đối chiếu quyền xóa đúng project/physical database theo [Docker](../docker/README.md#cấp-quyền-xóa-dữ-liệu-builder).
2. Trong **Đồ thị**, bấm **Xóa** ở đúng dòng. Đọc hộp thoại **Xóa đồ thị** và số nội dung sẽ xóa; đối chiếu database/identity tại OpenSPG và Neo4j trước khi xác nhận.
3. Chỉ sau khi đồng ý tác động, bấm **Xác nhận xóa**. UI không yêu cầu gõ tên database. Chờ kết quả đọc lại database rỗng; không coi request được nhận là đã hoàn tất.

Project/database, credentials, schema/index, volumes và lịch sử được giữ. Điểm lưu của đích đã xóa không thể Resume; kết quả cũ chỉ còn là lịch sử. Luồng xóa xử lý phiên đã dừng ở đích; không cần nút chấm dứt riêng trên UI.

Mặc định chưa có quyền xóa. Người vận hành phải cấp quyền cho đích cụ thể; quyền sở hữu, identity, database dùng chung/serving và GraphLock vẫn được kiểm. Nếu lỗi một phần, tải lại hiện trạng, đọc **Chi tiết kỹ thuật** rồi dùng **Xóa tiếp** khi phù hợp. Nếu giao dịch mất phản hồi, giữ nguyên khóa và nhờ người vận hành xử lý; không xóa khóa hoặc gửi lại mù.

### Dựng lại hoặc chuyển sang toàn bộ dữ liệu

Khi phiên trước đã kết thúc, bấm **+ Dựng đồ thị mới**, chọn project/database rỗng và phạm vi mới. Muốn toàn corpus, chọn **Toàn bộ dữ liệu** rồi đợi thống kê và **Xác nhận dựng**. UI hiện chỉ dựng mới vào đích trống; giữ graph cũ, ưu tiên tạo đích riêng thay vì xóa lượt nhỏ đã hoàn tất. Cùng số chiều chưa đủ để tái sử dụng vector: nguồn/model và provenance phải khớp; không tự xóa graph/index để vượt kiểm tra.

## Lỗi thường gặp

- Không có project để chọn: đăng nhập OpenSPG cùng hostname, kiểm project thuộc tài khoản rồi **Tải lại danh sách**.
- Không xác nhận được: kiểm nguồn/phạm vi đã tính xong, đích trống, Embedding đã lưu/kiểm và phiên trước đã kết thúc.
- Cấu trúc xung đột hoặc có dữ liệu: đọc lỗi; chọn project riêng phù hợp hoặc nhờ quản trị lập migration, không xóa loại tùy chỉnh.
- Model chưa kiểm hoặc endpoint bị chặn: lưu/kiểm đúng Embedding và nhờ vận hành kiểm chính sách kết nối.
- Hết hạn mức request: phiên cũ giữ hạn mức cũ; Resume không tăng ngân sách.
- Khóa đang giữ hoặc kết quả ghi chưa rõ: **Tải lại danh sách**. Nếu **Tiếp tục** khả dụng, dùng nút đó để Builder đọc lại. Nếu dữ liệu chỉ có một phần hoặc khác dự kiến, giữ khóa và nhờ quản trị đối soát.

## Dành cho quản trị và phát triển

### Đích Builder trong deployment

Compose cấp kết nối OpenSPG/Neo4j trong mạng private; UI chọn project theo ID từ phiên OpenSPG. Startup không tạo project, schema, index hoặc chạy Build. Endpoints, storage, quyền xóa và mạng: [Docker](../docker/README.md#builder).

### Config

Cấu hình sản phẩm và kế hoạch nguồn ở `kag-builder-state`; run/checkpoint ở `kag-builder-runs`, khóa chung ở `kag-builder-graph-locks`. Giữ cả ba cùng provider state khi cập nhật/sao lưu. Nguồn đã kiểm vẫn được Runner kiểm lại trước ghi; cache giao diện không cấp quyền ghi.

UI tự sinh cấu hình từ nguồn và đích đã chọn. Khi cần CLI, dùng [runner.example.json](../kag/config/runner.example.json) bên ngoài repo; template mặc định `DENY` và có DNS placeholder `builder-openspg`/`builder-neo4j`, phải thay bằng kết nối được cấp.

- `PRODUCTION/WRITE`: nguồn đã pin, chọn ALL/COUNT/PERCENT, model/dimension của phiên; cần confirmation đúng nguồn/đích, quyền project, identity vật lý và GraphLock.
- `FRESH_SAMPLE`: scope kiểm thử riêng, giới hạn 1–128 node, 1–256 cạnh, batch ≤32, replay. `C4_3A_MANIFEST_SAMPLE` giữ contract replay cũ. Không dùng các scope này cho toàn corpus.
- `paths` và hashes phải khớp inputs; run/lock roots ngoài repo. `credential_env` chỉ chứa tên biến, không ghi key vào JSON.
- Các biến `KAG_OPERATIONAL_PROOF`, `KAG_PRODUCTION_WRITE`, `KAG_PROVIDER_EGRESS` là policy startup API, không phải công tắc quyền Worker. Worker kiểm cấu hình/confirmation/identity/lock và policy provider riêng.

Chi tiết: [runtime](runtime.md), [schema](schema.md), [backend identity](backend-identity.md).

### Chạy CLI

Trong [runtime chuẩn](runtime.md), từ root ứng dụng. Mount cấu hình và nơi lưu run ngoài repo trước khi chạy. Ví dụ dưới dùng `/external/runner.json` và run ID `build-001`; thay bằng cấu hình/ID của bạn và chọn đúng một thao tác:

```sh
python -B -m kag run --config /external/runner.json --run-id build-001
python -B -m kag resume --config /external/runner.json --run-id build-001
python -B -m kag verify --config /external/runner.json --run-id build-001
```

`run`/`resume` có thể ghi graph và gọi provider theo config. `verify` không sửa graph/index nhưng ghi kết quả xác minh vào run. Exit 0: hoàn tất; 1: lỗi runtime/transport/provider; 2: bị chặn. Đọc `stage/error_code`, không ghi credentials hay raw exception body vào log.

### Source-only validation

[source-only.example.json](../kag/config/source-only.example.json) dùng `SOURCE_ONLY_DRY_RUN/NO_OP`. Cấp path/hash thật và run root ngoài repo; không nhận endpoint/provider/WRITE. Luồng này kiểm nguồn, không mở graph/provider và luôn có `graph_verified=false`.

### Stage và readback

Graph đi qua `preflight → plan → vectorize → export-artifact → write-nodes → verify-nodes → write-edges → verify → release`. Các công đoạn dùng đơn vị khác nhau, không cộng thành phần trăm chung.

Replay kiểm model/dimension/provenance; không tự chuyển sang provider khi thiếu vector. Writer ghi node trước, đọc lại node rồi mới ghi cạnh. Verify đối chiếu IDs/payload/vector/provenance và bốn index VECTOR đúng định nghĩa, ONLINE; số dự kiến không thay readback. Nhãn `release` ở công đoạn cuối chỉ ghi nhận kết quả Runner, chưa tạo bộ dữ liệu đã đóng gói để phục vụ Chat.

### Resume, trạng thái và lock

Worker dùng `builder-control-v3`; Java/frontend nhận v1/v2/v3. V1 chỉ có tiến độ stage hiện tại; v2 thêm tiến trình/kết quả gắn run/target; v3 thêm `ABANDONED`/`CLEARED`. Khi nâng từng phần, cập nhật clients tương thích v3 trước Worker v3.

Build/Resume/`abandon` dùng revision cấu hình; stale request bị từ chối. Poll chỉ đọc trạng thái; không gọi provider hoặc quét graph. Kết quả hoàn tất vẫn xem được sau restart, nhưng cần kiểm lại nguồn/sẵn sàng trước thao tác ghi mới.

Run giữ ledger SQLite (sổ tiến độ), checkpoint, artifacts và kết quả xác minh. Batch đã xác nhận được kiểm lại khi Resume. Batch ghi chưa rõ kết quả được đọc lại theo ID trên đúng database. Nếu đủ và khớp, Builder xác nhận batch. Nếu toàn bộ vắng mặt, Builder mới gửi lại. Nếu chỉ có một phần, payload khác hoặc đọc thất bại, Builder dừng và giữ khóa. Lỗi kết nối trước lần gửi đầu để lại batch chưa gửi, có thể thử lại bằng **Tiếp tục**. Resume giữ nguyên nguồn/schema/target/model/phạm vi/batch/hạn mức.

GraphLock khóa theo **physical database ID**: hai tên trỏ cùng database dùng chung khóa OS trên cùng named volume; không thay volume hoặc xóa file khóa để né xung đột. Khi holder chết, khóa OS tự nhả và metadata cũ hợp lệ cho phép lấy khóa lần sau. Lần ghi chưa xác định kết quả được đánh dấu `retained: UNCERTAIN_WRITE`. Chỉ Resume đúng run trên cùng database sau khi lấy được khóa OS mới được đối soát batch. Dựng mới và thao tác khác vẫn bị chặn. Khi nâng cấp từ khóa file cũ, dừng mọi writer cũ trước khi dùng writer mới; receipt không cấp quyền ghi hoặc phục vụ Chat.
