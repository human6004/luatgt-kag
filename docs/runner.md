# Dựng đồ thị bằng Builder

Dành cho quản trị viên tự tạo nơi lưu graph, chọn dữ liệu và dựng đồ thị trên WebApp. Mở **Dựng đồ thị** tại `/admin/pipeline`.

Builder dùng bộ dữ liệu nguồn (corpus) và cấu trúc dữ liệu (schema) đi kèm phiên bản ứng dụng; chưa hỗ trợ tải bộ nguồn tùy ý hoặc tự trích xuất tri thức từ văn bản trên UI.

Build thành công chưa tự đưa graph vào Chat. Mở **Đồ thị của tôi**, chọn project/phiên, thử truy xuất nếu muốn rồi **Dùng cho Chat** và xác nhận. Chat cần model tương thích và snapshot nguồn đi cùng graph, không cần nhập lại corpus vào WebApp. Xem [chọn graph phục vụ](#chọn-graph-phục-vụ-truy-xuấtchat).

## Chuẩn bị

- Đăng nhập LuậtGT bằng tài khoản **ADMIN**.
- Có tài khoản OpenSPG sở hữu project và quyền dùng database Neo4j riêng. [Nơi lấy tài khoản](../docker/README.md#truy-cập-quản-trị-openspg-và-neo4j).
- Có API key và model Embedding được hệ thống cho phép. Embedding là dịch vụ chuyển nội dung thành vector để tìm kiếm; kiểm model và dựng graph có thể tính phí.
- Dùng cùng hostname khi mở LuậtGT và OpenSPG, ví dụ đều là `127.0.0.1`; không trộn với `localhost`.

Ví dụ xuyên suốt: tên hiển thị **Luật giao thông**, namespace **RoadLaw**, database **roadlaw**. Thay bằng tên của bạn; không chọn database đang phục vụ Chat hoặc chứa dữ liệu ngoài phạm vi quản lý.

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

### 1. Dữ liệu

1. Trên LuậtGT, mở **Dựng đồ thị → Dữ liệu**.
2. Bấm **Kiểm tra và chuẩn bị**, đợi hoàn tất rồi đọc thống kê theo loại nội dung và quan hệ.
3. Bấm **Đến cấu hình**.

Các số này là nguồn dự kiến, chưa phải số đã ghi vào graph. Nguồn sai hoặc không đọc được thì xử lý lỗi được hiển thị; không sửa corpus để bỏ qua kiểm tra.

### 2. Cấu hình

#### Chọn nơi lưu và chuẩn bị cấu trúc

1. Trong **Nơi lưu**, bấm **Tải lại danh sách** rồi chọn **Project OpenSPG**. Xem **Chi tiết project** để đối chiếu ID/namespace/database; project trùng tên vẫn được phân biệt bằng ID.
2. Bấm **Xem thay đổi** để xem các loại/quan hệ sẽ xóa, giữ, thêm và tác động lên index.
3. Nếu cần thay đổi, bấm **Chuẩn bị cấu trúc LuậtGT**, đọc hộp xác nhận rồi bấm **Xác nhận chuẩn bị**.

Danh sách chỉ gồm project bạn sở hữu trong phiên đăng nhập OpenSPG. Quyền ADMIN LuậtGT không thay quyền sở hữu project Private.

Chuẩn bị cấu trúc có thể thay schema mặc định OpenSPG trên database rỗng và tạo/tạo lại index đã liệt kê. Đây là thay đổi cấu trúc, chưa dựng nội dung hoặc gọi Embedding. Có dữ liệu, loại tùy chỉnh hay phụ thuộc chưa rõ thì thao tác bị chặn; không xóa mọi loại ngoài LuậtGT.

Kết quả phân biệt **đủ cấu trúc để Build** với **đã loại bỏ schema mặc định**. Tên label cũ có thể còn trong sidebar Neo4j do metadata lịch sử; không cần xóa label tokens. Nếu lỗi một phần, đọc kết quả rồi **Xem thay đổi** lại trước khi xác nhận phần còn thiếu.

#### Chọn phạm vi dữ liệu

Trong **Phạm vi dữ liệu → Dữ liệu sẽ dựng**, chọn rõ một trong hai cách:

- **Toàn bộ dữ liệu:** dùng toàn bộ nguồn đã chuẩn bị.
- **Một phần dữ liệu:** chọn **Số lượng nội dung** hoặc **Tỷ lệ nội dung (%)**, rồi nhập số nguyên. Số lượng từ 3 đến tổng nguồn; tỷ lệ từ 1–100%, làm tròn lên.

Bấm **Xem trước phạm vi** và đọc thống kê trước khi lưu. Để trống ô số lượng/tỷ lệ không có nghĩa là toàn bộ; ô này bắt buộc khi chọn một phần. Phạm vi quá nhỏ để giữ đủ loại dữ liệu sẽ bị từ chối.

Tập một phần được chọn cố định, ưu tiên nội dung ngắn; văn bản nguồn, đơn vị cha và hai đầu quan hệ đều nằm trong giới hạn. Mức quá nhỏ không giữ đủ nguồn/các loại sẽ bị từ chối. Đây không phải mẫu ngẫu nhiên hoặc bảo đảm đại diện thống kê.

#### Chọn model và giới hạn

Trong **Dịch vụ tạo vector**, kiểm model, trạng thái key và kết quả kiểm kết nối. Nếu thiếu, mở **Cấu hình và kiểm kết nối Embedding**, làm theo [hướng dẫn model](USER-GUIDE.md#cấu-hình-model), rồi quay lại. Builder dùng Embedding đã lưu và kiểm thành công; không cần **Áp dụng Embedding** cho Chat.

Trong **Cấu hình nâng cao**:

| Trường | Ý nghĩa và mặc định |
| --- | --- |
| Kích thước batch | Số nội dung hoặc quan hệ xử lý mỗi batch; số nguyên 1–4096, mặc định **64** |
| Hạn mức request Embedding | Tổng lần gửi request tạo vector cho cả phiên, gồm retry từ vectorizer; số nguyên 1–1.000.000 hoặc **Không giới hạn**; mặc định **Không giới hạn** |

Hạn mức request không phải giới hạn token hay tốc độ model; cũng không quyết định tập dữ liệu được chọn. Nó đếm request từ ứng dụng, không bảo đảm số lần thử bên trong proxy/provider.

Cuối cùng, bấm **Lưu cấu hình dựng**. Cấu hình được giữ sau tải lại trang, áp dụng cho phiên mới. Chưa gọi provider hay bắt đầu Build.

Nếu nút Lưu chưa dùng được: kiểm project, model đã kiểm, số hợp lệ và **Xem trước phạm vi** còn khớp lựa chọn hiện tại. Khi phiên chưa kết thúc, cấu hình bị khóa để giữ khả năng tiếp tục đúng điểm lưu.

### 3. Sẵn sàng

Bấm **Kiểm tra sẵn sàng**. Hệ thống kiểm nguồn, model, quyền project, database, cấu trúc, index và khóa ghi.

Nếu thiếu điều kiện, dùng nút dẫn về phần cần sửa rồi kiểm lại. Bước này không gọi provider, tạo project/index hoặc ghi graph. Đổi nguồn/model/đích/cấu hình liên quan cần kiểm lại.

### 4. Đang dựng

1. Bấm **Bắt đầu dựng**.
2. Đọc hộp xác nhận: project/database, model, phạm vi và số lượng dự kiến, batch, hạn mức request.
3. Khi chấp nhận phạm vi ghi và chi phí Embedding, bấm **Xác nhận bắt đầu**.

Theo dõi bảng công đoạn tại bước này. Số đã xử lý và tổng chỉ hiện khi có số liệu; không có thời gian hoàn tất dự đoán cho toàn phiên. Trang tự cập nhật khoảng ba giây một lần.

Tải lại/rời trang không dừng Worker. Mất phản hồi chưa chứng minh Build thất bại; chờ hoặc **Tải lại trạng thái**, không gửi Build lặp.

### 5. Kết quả

Khi hoàn tất, bấm **Xem kết quả đã xác minh**. Trang hiển thị số node, quan hệ và vector đã xác minh của đúng phiên và database, tách khỏi thống kê nguồn dự kiến.

- **Về tiến trình phiên:** xem lại bảng công đoạn.
- **Xem đồ thị:** mở kết quả phiên trên LuậtGT.
- **Mở Neo4j · roadlaw:** mở Browser cho database của phiên, kể cả khi sau này chọn project khác.

Nếu Browser hỏi kết nối, dùng `bolt://127.0.0.1:7687` và tài khoản Neo4j. Chọn đúng database trước khi đọc. Với ví dụ `roadlaw`, chạy từng lệnh:

```cypher
:use roadlaw
MATCH (n) RETURN n LIMIT 25;
MATCH (a)-[r]->(b) RETURN a,r,b LIMIT 25;
```

Thay `roadlaw` bằng database hiển thị trong kết quả. **Knowledge Model là cấu trúc; graph sau Build là dữ liệu.** Kết quả một phần không chứng minh đã dựng toàn corpus.

Bạn có thể xem graph hiện tại hoặc [chọn graph phục vụ](#chọn-graph-phục-vụ-truy-xuấtchat). Kết quả một phần chỉ xác minh phạm vi đã chọn; chưa chứng minh toàn corpus hay chất lượng trả lời luật.

## Chọn graph phục vụ truy xuất/Chat

1. Mở **Đồ thị của tôi → Project đang xem → Phiên dựng**. **Tổng quan** đọc số liệu hiện tại; kết quả phiên dựng là lịch sử riêng.
2. **Thử truy xuất** là tùy chọn: nhập câu hỏi, chọn số kết quả và mở rộng quan hệ khi cần. Request dùng đúng graph đang xem, không chuyển graph Chat; có thể tính phí Embedding.
3. Mở **Dùng cho Chat → Dùng cho Chat**. Kiểm nội bộ chạy tự động; hộp xác nhận nêu graph cũ/mới, phạm vi và model. Endpoint/model Embedding phải khớp phiên dựng, cùng số chiều chưa đủ.
4. Thiếu model thì **Chỉnh model**, lưu/kiểm Chat và Embedding rồi **Về đồ thị đang chọn**. Nguồn thiếu/hỏng phải xử lý đúng snapshot/phiên, không nhập lại MySQL để vượt lỗi. Màn xem **Dữ liệu nguồn** không yêu cầu duyệt lại dataset.
5. Bấm **Xác nhận dùng cho Chat** khi đủ điều kiện. Chỉ coi đã đổi sau khi backend xác nhận **Đang dùng**. Không bắt gửi câu thử hoặc chạy benchmark.
6. **Mở Chat** và đối chiếu trích dẫn. Nội dung trích dẫn lưu cùng câu trả lời, giữ nguồn cũ sau khi đổi graph.

Project đang xem, đích Builder và graph phục vụ độc lập. Chọn project để xem không tự đổi Chat. Kích hoạt giữ lựa chọn qua restart và bảo vệ database đang phục vụ khỏi Build/xóa qua Builder, kể cả project khác trỏ cùng database. Muốn quay lại graph cũ, chọn đúng project/phiên và kiểm lại bằng cùng quy trình; không tự khôi phục dữ liệu graph cũ.

Preview cũ, graph thay đổi, thiếu quyền hoặc model/index không khớp sẽ bị chặn. Kích hoạt thất bại giữ lựa chọn cũ; mất phản hồi thì **Tải lại** trước khi thử lại. Release mới giữ source snapshot của đúng graph. Release legacy vẫn giữ kiểm publication WebApp; cập nhật phần mềm không tự viết lại hoặc chuyển release. [Chi tiết publisher legacy](../docker/README.md#publisher-nâng-cao).

## Dừng, bỏ phiên và dựng lại

### Dừng và tiếp tục

Bấm **Dừng an toàn**, chờ **Đã dừng an toàn**. Tiến độ và dữ liệu được giữ để **Tiếp tục dựng** sau. Đóng trang hoặc dừng theo dõi log không dừng Worker.

Tiếp tục dùng cùng phiên, nguồn, đích, model, batch và hạn mức cũ; số request đã dùng không được đặt lại. Sau Worker restart, vào **Dữ liệu → Kiểm tra lại dữ liệu** rồi **Sẵn sàng → Kiểm tra sẵn sàng** trước khi tiếp tục. Không sửa cấu hình hoặc xóa khóa để ép tiếp tục.

### Bỏ phiên

Sau khi dừng an toàn và hệ thống cho phép, bấm **Bỏ phiên → Xác nhận bỏ phiên**. Phiên không thể tiếp tục nữa; graph, vector, điểm lưu và lịch sử vẫn được giữ. Bạn có thể cấu hình phiên mới, nhưng dữ liệu cũ vẫn phải tương thích với nguồn/model của phiên đó.

### Xóa dữ liệu đồ thị

**Thao tác này xóa toàn bộ node và quan hệ trong database chuyên dụng được cấp quyền, không chỉ dữ liệu của một phiên. Không có hoàn tác nguyên tử.** Chỉ dùng khi đã sao lưu và muốn làm trống đúng database đó.

1. Nếu phiên đang dừng chờ tiếp tục, **Bỏ phiên** trước.
2. Mở **Xóa dữ liệu để dựng lại → Xem trước xóa dữ liệu**.
3. Đọc project, database, định danh vật lý và số dữ liệu sẽ xóa.
4. Bấm **Xóa dữ liệu đồ thị**, nhập đúng tên database rồi bấm nút **Xóa dữ liệu trong roadlaw** tương ứng đích của bạn.

Project/database, credentials, schema/index, volumes và lịch sử được giữ. Điểm lưu của đích đã xóa không thể Resume; kết quả cũ chỉ còn là lịch sử. Chỉ hoàn tất sau khi đọc lại database rỗng và cấu trúc vẫn đúng.

Nút xóa mặc định bị chặn. Người vận hành phải [cấp quyền cho đích cụ thể](../docker/README.md#cấp-quyền-xóa-dữ-liệu-builder); database dùng chung, serving hoặc giao dịch chưa rõ kết quả vẫn bị từ chối. Nếu lỗi một phần, xem lại hiện trạng và preview phần còn lại. Nếu giao dịch mất phản hồi, giữ nguyên khóa và nhờ người vận hành xử lý; không xóa khóa hoặc gửi lại mù.

### Dựng lại hoặc chuyển sang toàn bộ dữ liệu

Khi phiên trước đã kết thúc:

1. Về **Cấu hình**; sau xóa có nút **Về cấu hình phiên mới**. Kiểm/chuẩn bị lại cấu trúc nếu cần.
2. Chọn phạm vi mới. Muốn dựng toàn corpus, chọn **Toàn bộ dữ liệu → Xem trước phạm vi**.
3. Kiểm batch và hạn mức đang lưu. Chuyển sang toàn bộ **không tự bỏ hạn mức**; giữ số đã đặt hoặc chủ động chọn **Không giới hạn** khi chấp nhận chi phí.
4. Lưu → kiểm sẵn sàng → bắt đầu dựng; đọc lại phạm vi, model, đích và hạn mức trong hộp xác nhận.

Không bắt buộc xóa một lượt nhỏ đã hoàn tất để dựng tiếp cùng nguồn/model. Hệ thống phải đối chiếu dữ liệu/vector cũ và lịch sử xác minh; cùng số chiều chưa đủ. Thiếu lịch sử hoặc không tương thích thì dùng project rỗng, không tự xóa graph/index để vượt kiểm tra.

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| Không có project để chọn | Đăng nhập OpenSPG cùng hostname, kiểm project thuộc tài khoản rồi **Tải lại danh sách** |
| Không lưu được cấu hình | Kiểm nguồn đã chuẩn bị, project hợp lệ, model đã kiểm, số nguyên hợp lệ và preview phạm vi mới nhất |
| Cấu trúc có xung đột hoặc có dữ liệu | Đọc danh sách xung đột; dùng project riêng phù hợp hoặc nhờ quản trị lập migration, không xóa loại tùy chỉnh |
| Model chưa kiểm hoặc endpoint bị chặn | Lưu/kiểm đúng Embedding và nhờ vận hành kiểm chính sách kết nối model |
| Dữ liệu/vector cũ không khớp model | Dùng model gốc cùng lịch sử run hoặc chọn project rỗng |
| Hết hạn mức request | Phiên cũ giữ hạn mức cũ; không thể tăng ngân sách bằng Resume |
| Khóa đang được giữ hoặc kết quả ghi chưa rõ | Kiểm đúng phiên giữ khóa; giữ khóa và nhờ vận hành đối soát |
| Mất kết nối, timeout | **Tải lại trạng thái**, đợi kết quả server trước khi thử thao tác khác |

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

Build/Resume/Bỏ phiên dùng revision cấu hình; stale request bị từ chối. Poll chỉ đọc trạng thái; không gọi provider hoặc quét graph. Kết quả hoàn tất vẫn xem được sau restart, nhưng cần kiểm lại nguồn/sẵn sàng trước thao tác ghi mới.

Run giữ ledger SQLite (sổ tiến độ), checkpoint, artifacts và kết quả xác minh. Batch đã xác nhận không gửi lại. Batch ghi chưa rõ kết quả phải đọc lại; thiếu/khác/không chắc thì chặn, không resend mù. Resume giữ nguyên nguồn/schema/target/model/phạm vi/batch/hạn mức.

GraphLock khóa theo **physical database ID**: hai tên trỏ cùng database dùng chung khóa. Mọi writer phải dùng cùng named volume; không thay volume hoặc xóa khóa để né xung đột. Crash giữ stale lock; chỉ phục hồi sau khi xác định owner/process/run/target và tình trạng giao dịch. Receipt là bản ghi kết quả, không cấp quyền ghi hoặc phục vụ Chat.
