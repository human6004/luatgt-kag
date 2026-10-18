# Builder và runner

Runner dựng/kiểm graph theo batch, giữ tiến độ để dừng và tiếp tục an toàn. Không chạy lúc startup. [Runtime](runtime.md) quy định Python/SDK; [schema](schema.md) và [backend identity](backend-identity.md) quy định dữ liệu/target.

## Cấu hình trên WebApp

Spring Boot kiểm ADMIN, gửi control token riêng tới `openspg-server:8010`; BuilderControl chạy Runner trong một thread, không dùng Docker Socket.

Builder dùng dữ liệu/schema đi kèm ứng dụng. Không nhận upload hoặc đường dẫn từ trình duyệt. Kế hoạch nguồn và cấu hình lưu trong volume `kag-builder-state`; ledger/checkpoint ở `kag-builder-runs`. Giữ cả hai khi backup hoặc cập nhật.

**Mặc định Builder BLOCKED.** Worker nhận `FRESH_SAMPLE/WRITE/replay-existing` với grant biệt lập, hoặc `PRODUCTION/WRITE` với confirmation gắn project/namespace/ID/plan đã pin. Runner vẫn kiểm nguồn, vector, identity và GraphLock trước ghi; trạng thái quyền đã cấu hình không chứng minh ghi thành công.

Lưu endpoint, model và API key Embedding trong **Cấu hình**, rồi kiểm kết nối. Kiểm model gửi request thật, có thể tính phí. Builder đọc bản Embedding đã lưu và kết quả kiểm của đúng revision từ secret store hiện hữu; không cần Apply cho Chat. Key không nằm trong cấu hình Runner hoặc response Builder. Worker chỉ mount secret store ở chế độ đọc.

Trong **Cấu hình nâng cao**, **Kích thước batch** nhận 1–4096 nội dung hoặc quan hệ xử lý mỗi batch; mặc định sản phẩm là 64. **Hạn mức request Embedding** nhận 1–1.000.000 lần gửi request tạo vector cho cả phiên, hoặc chọn **Không giới hạn** (mặc định, API lưu `null`). Đây là số request, không phải giới hạn token hoặc tốc độ model. Cấu hình lưu bền vững; tải lại trang vẫn giữ lựa chọn. Thay đổi đã lưu áp dụng cho phiên dựng mới, không đổi cấu hình Resume.

Số request được ghi bền vững trong ledger, gồm các lần retry của vectorizer; Resume không làm mới hạn mức. Số này đếm client dispatch, không khẳng định số attempt bên trong proxy. Proxy chỉ được dùng khi deployment xác nhận an toàn hoặc chấp nhận retry upstream bằng `KAG_CHAT_PROXY_ALLOW_UPSTREAM_RETRIES=1`. Chính sách mạng/hostname vẫn bắt buộc.

Kiểm sẵn sàng đọc nguồn, cấu hình Embedding, quyền project, database identity, schema, bốn vector indexes và khóa ghi. Thao tác này không gọi provider, không tạo project/index và không ghi graph. Thay nguồn/model/target/chính sách egress làm mất hiệu lực kết quả. Runner kiểm lại trước dispatch. Không đổi cấu hình của phiên đang chạy, đang dừng hoặc đã dừng chờ Resume; Resume giữ cùng run ID và cấu hình đã chốt. Dừng đợi batch/readback/checkpoint. **Bỏ phiên** và **Xóa dữ liệu đồ thị** là hai thao tác riêng bên dưới.

Snapshot đầu vào chỉ kiểm file có mặt, không hash vector lớn trong request HTTP; `NOT_CHECKED` nghĩa là chưa kiểm checksum. Kiểm nguồn chạy nền và chỉ xác thực nguồn C3, còn vector được Runner kiểm trước Build. Cache giao diện theo cấu hình và metadata inode/kích thước/mtime/ctime; sau phục hồi bảo toàn metadata, bấm **Kiểm tra nguồn** lại. Runner luôn kiểm checksum thật trước dispatch, không dùng cache giao diện làm quyền ghi.

### Dựng đồ thị qua 5 bước

Đăng nhập ADMIN, mở **Dựng đồ thị**. Tạo [Knowledge Base](#chọn-project-và-nạp-schema) trong OpenSPG, rồi chuẩn bị cấu trúc ngay trên LuậtGT. Đăng nhập OpenSPG trên cùng hostname với LuậtGT: ví dụ cả hai dùng `127.0.0.1`, không trộn với `localhost`.

1. **Dữ liệu:** chọn **Kiểm tra và chuẩn bị**. Worker kiểm corpus/schema đi kèm và tạo kế hoạch; thống kê riêng văn bản pháp luật, đơn vị nội dung, biển báo và từng quan hệ. Đây là tổng nguồn dự kiến, chưa phải dữ liệu đã dựng.
2. **Cấu hình:** phần **Nơi lưu**, bấm **Mở OpenSPG**, đăng nhập nếu cần; quay lại **Tải lại danh sách**, chọn **Project OpenSPG** theo tên và database. ID/namespace trong chi tiết; tên trùng được phân biệt bằng ID. Danh sách chỉ gồm project bạn sở hữu trong phiên OpenSPG; ADMIN LuậtGT không cấp quyền đọc mọi project PRIVATE. Bấm **Xem thay đổi**, đọc tác động schema/index; nếu thiếu, bấm **Chuẩn bị cấu trúc LuậtGT** → **Xác nhận chuẩn bị**. Trong **Phạm vi dữ liệu**, chọn rõ **Toàn bộ dữ liệu** hoặc **Một phần dữ liệu** theo số lượng/tỷ lệ, rồi **Xem trước phạm vi**. Trong **Dịch vụ tạo vector**, model thiếu thì mở **Cấu hình và kiểm kết nối Embedding**, lưu/test bằng key của installation. **Cấu hình nâng cao** giữ batch/hạn mức đã lưu; chỉ chủ động chọn **Không giới hạn** khi chấp nhận chi phí. **Lưu cấu hình dựng** chốt project và phạm vi, không gọi provider.
3. **Sẵn sàng:** chọn **Kiểm tra sẵn sàng**. Mục chưa kiểm nêu điều kiện đang chờ; lỗi có nút về Dữ liệu, Cấu hình/cấu trúc hoặc Embedding. Khóa ghi hiện phiên/project giữ khóa khi đọc được, chỉ gắn trạng thái Worker nếu đúng phiên. Giữ nguyên khóa nếu chưa rõ kết quả. Preflight chỉ đọc, không tạo index/project hoặc gọi provider.
4. **Đang dựng:** theo dõi bảng công đoạn tại bước này; bảng có sẵn trước khi chạy. Chọn **Bắt đầu dựng**, kiểm hộp xác nhận: đúng đích, model, phạm vi/số nội dung và quan hệ, batch và hạn mức request, rồi **Xác nhận bắt đầu**. Bảng cập nhật theo polling khoảng ba giây, đọc tiến độ đã ghi nhận. **Dừng an toàn** đợi batch/checkpoint; **Tiếp tục dựng** giữ cùng phiên. Sau Worker restart, kiểm dữ liệu và sẵn sàng lại trước khi tiếp tục. Hoàn tất thì chọn **Xem kết quả đã xác minh**.
5. **Kết quả:** xem số node/quan hệ/vector **đã xác minh** của đúng run/physical target, tách khỏi bảng tiến trình và số **Dự kiến**. **Về tiến trình phiên** quay lại bảng công đoạn. **Xem đồ thị** mở kết quả phiên; **Mở Neo4j** chọn database của chính phiên đó, kể cả khi sau này chọn project khác. Nếu Browser chưa chọn đúng, chạy `:use <database-hiển-thị>` rồi truy vấn chỉ đọc có `LIMIT 25` như hướng dẫn trên UI. Knowledge Model của OpenSPG hiển thị cấu trúc, Neo4j hiển thị dữ liệu sau Build. Database rỗng trước Build là bình thường. Chat cần được kích hoạt riêng.

Refresh chỉ đọc trạng thái. Khi mất kết nối, trang giữ lần đọc gần nhất và tắt thao tác cho tới khi kết nối lại. Timeout chưa chứng minh Build thất bại; chờ trạng thái, không gửi lại hoặc xóa khóa. Mã lỗi và binding nằm trong chi tiết kỹ thuật; không chia sẻ secrets hoặc raw logs.

Sau lượt giới hạn **Hoàn tất**, muốn tự dựng toàn corpus:

1. Quay lại **Cấu hình → Phạm vi dữ liệu**, chọn **Toàn bộ dữ liệu → Xem trước phạm vi**. Đọc tổng nguồn và số từng loại; ô trống không có nghĩa là toàn bộ.
2. Mở **Cấu hình nâng cao**, kiểm batch và hạn mức đang lưu. Chuyển sang toàn corpus **không tự bỏ hạn mức**; giữ số đã đặt hoặc chủ động chọn **Không giới hạn** nếu chấp nhận chi phí. Khi hết hạn mức, Runner chặn request tiếp theo; Resume giữ số đã dùng và không cấp thêm ngân sách.
3. **Lưu cấu hình dựng** → **Sẵn sàng** → **Kiểm tra sẵn sàng** → **Đang dựng** → **Bắt đầu dựng**.
4. Kiểm hộp xác nhận ghi **toàn bộ corpus**, đúng số lượng nguồn/đích/model, **Kích thước batch** và **Hạn mức request Embedding**. Chỉ bấm **Xác nhận bắt đầu** khi chấp nhận phạm vi và chi phí.

Đích phải thuộc installation được cấp. Muốn mở rộng trên graph đã dựng, giữ đúng model và lịch sử run/checkpoint: preflight đối chiếu payload/vector thực với chỉ mục xác minh của các phiên cùng physical database, namespace và model. Cùng số chiều chưa đủ. Thiếu lịch sử hoặc dữ liệu khác thì chọn project rỗng; không tự xóa graph/index. Phiên **Đã dừng** chỉ cho tiếp tục cấu hình cũ. Kết quả lượt giới hạn không chứng minh full graph hoặc chất lượng Chat.

### Phạm vi được chốt thế nào

Số lượng nhận số nguyên từ 3 đến tổng nguồn. Tỷ lệ nhận số nguyên 1–100%, quy đổi làm tròn lên `tổng node × tỷ lệ / 100`. Yêu cầu quá nhỏ để giữ đủ loại và đầu mút quan hệ bị từ chối; không tự nâng số. Thuật toán ưu tiên nội dung ngắn, đủ loại rồi bổ sung node; cùng nguồn/yêu cầu cho cùng tập chọn. Đây không phải mẫu ngẫu nhiên hay bảo đảm đại diện thống kê. Giữ tất cả cạnh có đủ hai đầu mút trong tập chọn, báo riêng quan hệ ngoài phạm vi.

Preview gửi số lượng, không gửi hàng nghìn ID tới trình duyệt. Tập chọn nằm trong artifacts kế hoạch và gắn hash vào cấu hình/run; Build và Resume dùng đúng tập đã chốt. Nguồn hoặc cấu hình đổi thì phải preview/kiểm sẵn sàng lại. Hạn mức request giới hạn chi phí, không quyết định phạm vi nguồn.

### Dừng, bỏ phiên và dựng lại

- **Dừng an toàn**: chờ **Đã dừng an toàn**; giữ graph và điểm lưu, có thể **Tiếp tục dựng** đúng phiên/cấu hình. Bảng tiến trình có sẵn các công đoạn, đọc số đã xử lý/tổng từ ledger. Thanh tiến độ chỉ hiện khi có tổng đáng tin; không có phần trăm toàn phiên hoặc ETA giả.
- **Bỏ phiên**: chỉ dùng sau khi dừng an toàn, không còn ghi chưa rõ kết quả. Xác nhận trên UI chấm dứt Resume; giữ graph, vector artifacts, checkpoint và lịch sử. Sau đó được cấu hình phiên mới; graph cũ vẫn phải qua kiểm tương thích.
- **Xóa dữ liệu đồ thị**: làm trống **toàn bộ database chuyên dụng đã được deployment cấp quyền**, không phải rollback riêng một run. Không dùng để bỏ phiên đang chạy.

Mở **Xóa dữ liệu để dựng lại → Xem trước xóa dữ liệu**. Đọc project/database, physical ID, số node/quan hệ; bấm **Xóa dữ liệu đồ thị**, nhập đúng tên database rồi xác nhận. Server kiểm lại quyền, target, dữ liệu, schema/index, tham chiếu serving và GraphLock. Preview cũ bị từ chối. Xóa theo batch tối đa 500 mục, quan hệ trước node; giữ project, database, credentials, schema/index, volumes và lịch sử. Không có rollback nguyên tử; tiến trình chỉ đếm batch đã được xác nhận.

Chỉ báo hoàn tất khi đọc lại database rỗng và schema/index giữ nguyên. Checkpoint cùng physical target được đánh dấu không thể Resume trước lượt xóa; kết quả cũ chỉ là lịch sử. Readiness cũ mất hiệu lực. Lỗi một phần: xem trước lại hiện trạng rồi xác nhận phần còn lại. Mất phản hồi giao dịch: giữ khóa, nhờ quản trị đối soát; không tự xóa khóa. Worker restart không tự gửi lại thao tác.

Sau xóa: **Về cấu hình phiên mới → Xem thay đổi** để kiểm/chuẩn bị cấu trúc → chọn phạm vi/model → lưu → kiểm sẵn sàng → tự xác nhận Build mới. Nguồn/mapping/schema đã thay đổi hợp lệ phải chuẩn bị lại kế hoạch. Không Resume khác source/schema/model/dimension/target/phạm vi, không dùng lại vector chỉ vì cùng số chiều. Không tự Build hoặc chuyển Chat sau xóa.

Quản trị deployment cấp quyền bằng `KAG_BUILDER_CLEAR_TARGETS`, JSON gồm các cặp `project_id` và `database_id` vật lý đã kiểm, ví dụ `[{"project_id":123,"database_id":"<physical-database-id>"}]`. Mặc định `[]` từ chối mọi đích. Không suy quyền xóa từ tên, namespace hay ADMIN. Áp dụng cấu hình deployment bằng quy trình cập nhật Compose; không tự cấp project thật. Worker còn chặn database được project khác dùng chung, catalog/alias chưa rõ, runtime serving hoặc release Chat tham chiếu, run chưa kết thúc và lần ghi bất định. Mount release chỉ đọc dùng cùng nguồn với runtime truy vấn.

## Config

Image sản phẩm chứa dataset/schema và ba artifacts XREF đã pin của phiên bản đó. Khi Worker có `KAG_BUILDER_STATE_DIR` (Compose: `/builder-state`), nút **Kiểm tra và chuẩn bị** kiểm nguồn và tạo kế hoạch từ dữ liệu đi kèm; không nhận upload hoặc đường dẫn từ trình duyệt. Kế hoạch hoàn chỉnh được xuất atomic dưới `plans/<phiên bản kế hoạch>` trong state volume và tái sử dụng nếu còn khớp. Nguồn sai thì dừng, không tự sửa corpus hoặc ghi đè kế hoạch đang có. Sau restart, kiểm lại để xác nhận nguồn hiện tại; không cần copy plan từ workspace phát triển.

### Đích Builder trong deployment

Quản trị hạ tầng cấp kết nối OpenSPG/Neo4j trong mạng private của Worker. Không dùng database đang phục vụ; bảo vệ theo tên và physical database ID. Image pin trong [Dockerfile](../docker/kag-api/Dockerfile), service/storage trong [Compose](../docker-compose.kag.yml). Startup không tạo project, schema, index hoặc chạy Build.

### Chọn project và nạp schema

Mở [OpenSPG localhost](http://127.0.0.1:8887/), đăng nhập tài khoản OpenSPG theo [hướng dẫn quản trị](../docker/README.md#truy-cập-quản-trị-openspg-và-neo4j). Nếu gặp **Reset Password**, chủ tài khoản tự hoàn tất đổi mật khẩu trước; WebApp không quản lý tài khoản này.

UI đi kèm image có **Create Knowledge Base**, hộp **New Knowledge Base**:

- **Chinese name of knowledge base**: tên hiển thị, có thể dùng tiếng Việt.
- **English name of knowledge base**: namespace, bắt đầu bằng chữ cái ASCII, sau đó chữ/số/gạch dưới, tối đa 64 ký tự; ví dụ `RoadLaw`. Namespace trùng bị OpenSPG từ chối; database native còn viết thường namespace nên không dùng hai tên chỉ khác hoa/thường.
- Chọn **Private**, **Local**. Trong **Figure Storage Configuration**, thay URI mặc định `neo4j://release-openspg-neo4j:7687` bằng `neo4j://openspg-neo4j:7687` của Compose này; user/password lấy từ cấu hình Neo4j deployment. Không dùng URI localhost của Browser cho kết nối giữa containers.
- **database** trong hộp tạo bị khóa; runtime tạo/chọn database từ namespace viết thường, ví dụ `RoadLaw` → `roadlaw`. Kiểm database có sẵn trước khi Save; không chọn namespace dẫn tới database serving hoặc dữ liệu không thuộc quyền quản lý.
- **Vector configuration**: chọn model Embedding OpenSPG; thiếu model thì bấm tên tài khoản góc phải → **Model Configuration**, thêm model theo hướng dẫn dưới đây. Catalog này độc lập với Embedding trong LuậtGT. Chọn ngôn ngữ mà phiên bản cung cấp; schema/corpus LuậtGT do Builder quyết định.

Sau khi người dùng Save, xem **Configuration** của đúng thẻ project, đối chiếu ID/namespace/database rồi **Modeling** để xem schema. Tên giống nhau không phải cùng project. LuậtGT giữ từng ID riêng, không gom danh sách theo tên/namespace.

**UI tạo Knowledge Base cần Embedding, không bắt buộc Chat.** Khi lưu model Embedding và khi Save Knowledge Base, OpenSPG chạy validator upstream: gửi `POST <base_url>/embeddings` với model đã nhập, `input: "hello"`, rồi lấy số chiều từ vector trả về. Đây là inference thật, có thể tính phí; không phải kiểm kết nối chỉ đọc. SDK không retry và không theo redirect; lớp Java native có cơ chế retry riêng, proxy được đăng ký cũng có thể retry/fallback theo policy của installation. Không coi một lần bấm là cam kết đúng một upstream attempt.

### Thêm Embedding cho OpenSPG

1. Bấm tên tài khoản góc phải → **Model Configuration** → thẻ **OpenAI** → **Add Model**. Thẻ này dùng được cho API tương thích OpenAI, không buộc dùng model của OpenAI.
2. **Supplier Presentation Name**: tên dễ nhận biết; **Model Type**: `embedding`; **Visible range**: **Private**.
3. **base_url**: base URL provider đã được deployment cho phép, gồm tiền tố API nếu có, ví dụ `https://<host-đã-duyệt>/v1`; không nhập `/embeddings`, query, user/password hoặc dấu `/` cuối. Không nhập địa chỉ gateway nội bộ vào trường này.
4. **API-Key**: key do nhà cung cấp hoặc proxy của installation cấp; **Model**: chính xác ID model Embedding provider hỗ trợ. Tài khoản OpenSPG/Neo4j, mật khẩu database và gateway token không phải API key model. LuậtGT chỉ hiển thị key đã lưu ở dạng che, không tự sao chép key sang OpenSPG; dùng bản key gốc do bạn quản lý nếu muốn dùng cùng provider. **Add Custom Field** không cần cho cấu hình OpenAI-compatible thông thường.
5. Bấm **OK** khi chấp nhận request kiểm thật và lưu model/key vào catalog OpenSPG MySQL theo quyền **Private**. Quay lại **Knowledge Base → Create Knowledge Base** và chọn model vừa lưu trong **Vector configuration**. **Save** Knowledge Base còn kiểm Embedding thật lần nữa, tạo project/database native; kiểm namespace/database đích trước khi bấm.

Compose giữ OpenSPG/Worker trong mạng internal. Bridge Embedding dùng cùng gateway, secret token và allowlist với API/Builder; không có đường Internet trực tiếp. Bật/cấp endpoint theo [cấu hình provider](../docker/README.md#provider-cho-openspg). Hiện đường này hỗ trợ vectorizer `openai` từ thẻ **OpenAI**; các loại khác bị chặn, không dùng chúng để né policy. Cấu hình Chat trên LuậtGT vẫn độc lập; đường kiểm Chat native OpenSPG không nằm trong tích hợp Embedding này.

SDK pin cung cấp [ProjectClient.create](https://github.com/OpenSPG/KAG/blob/fdab15b3929d2ee40dfcdd388f90233096a6afc9/knext/project/client.py) và [SPGSchemaMarkLang.sync_schema](https://github.com/OpenSPG/KAG/blob/fdab15b3929d2ee40dfcdd388f90233096a6afc9/knext/schema/marklang/schema_ml.py). CLI `knext project create` còn kiểm Chat; không dùng CLI thay cho UI như một phép kiểm chỉ đọc.

Quay lại LuậtGT **Dựng đồ thị → Cấu hình**, **Tải lại danh sách**, chọn project vừa tạo rồi **Xem thay đổi**. Worker dùng schema LuậtGT đi kèm, ánh xạ namespace trong RAM; không sửa corpus. Preview liệt kê từng loại/quan hệ xóa, giữ, thêm và từng index giữ/xóa/tạo lại; bốn index nội dung cần thêm cũng được hiển thị. Không gọi vectorizer/provider, chưa dựng dữ liệu.

Nếu có thay đổi hợp lệ, chọn **Chuẩn bị cấu trúc LuậtGT** → đọc đúng project/database, danh sách xóa và tác động index → **Xác nhận chuẩn bị**. Server kiểm lại quyền chủ sở hữu, revision, identity vật lý, số dữ liệu, schema và preview ngay trước apply; dùng cùng GraphLock với Build. Chỉ thay schema mặc định trên database vật lý rỗng. Hỗ trợ cả project mới và project đã có LuậtGT nhưng còn mặc định. Nhận diện 18 loại theo [định nghĩa OpenSPG v0.8](https://github.com/OpenSPG/openspg/blob/ceeb3ef549df79ca4c4878e7ff452c73584991f3/server/api/http-server/src/main/java/com/antgroup/openspg/server/api/http/server/openapi/SchemaController.java#L69), đã đối chiếu image pin: đúng loại, nhãn, cha, thuộc tính, ràng buộc, cấu hình index, semantics và không có quan hệ tùy chỉnh; không chỉ so tên. Các kiểu hệ thống Text/Integer/Float/STD được giữ.

Native SDK xóa đúng các loại mặc định đã xác nhận, đồng thời sync các loại LuậtGT giữ lại để fulltext dùng đúng cấu trúc. Index mặc định chỉ xóa khi tên và định nghĩa khớp native; index LuậtGT bị native tạo lại được báo rõ, kể cả index nội dung đang đúng. Các index khác giữ nguyên hoặc chặn khi chưa rõ tác động. Khi không cần sync schema, index đúng được giữ, chỉ thêm phần thiếu. Kiểm dimension từ cấu hình native OpenSPG; preflight còn đối chiếu với Embedding LuậtGT đã kiểm.

Có dữ liệu thì chặn thay schema/xóa index mặc định (`SCHEMA_DATA`). Có loại tùy chỉnh, loại trùng tên nhưng khác định nghĩa, quan hệ phụ thuộc hoặc index chưa rõ thì chặn xóa (`SCHEMA_CUSTOM`); UI liệt kê xung đột. Index nội dung sai/chưa ONLINE báo `INDEX`. Chọn project riêng hoặc thực hiện migration có chủ đích ngoài luồng thông thường. Không dùng full `sync_schema()` để ép qua: [SDK pin](https://github.com/OpenSPG/KAG/blob/fdab15b3929d2ee40dfcdd388f90233096a6afc9/knext/schema/marklang/schema_ml.py) có thể xóa định nghĩa vắng mặt.

Chỉ báo hoàn tất khi đọc lại OpenSPG không còn các loại mặc định trong phạm vi xác nhận, LuậtGT đầy đủ, Neo4j không còn index mặc định đã liệt kê; mọi index dự kiến tạo/tạo lại đều đúng định nghĩa và ONLINE, bốn content indexes đúng dimension/cosine. UI phân biệt **đủ cấu trúc để Build** với **đã loại bỏ schema mặc định**. Tên label cũ có thể còn trong sidebar Neo4j do label tokens lịch sử; đây không phải bằng chứng còn schema/dữ liệu. Không xóa label tokens.

Nếu đã đúng sẵn, UI báo không cần ghi thêm. Timeout/reload chỉ tải trạng thái server, không gửi apply lặp. Lỗi một phần hiện kết quả đọc lại/phần còn thiếu, kể cả index mặc định còn sót sau khi schema đã xóa; bấm **Xem thay đổi** lại để tiếp tục an toàn. Không có rollback nguyên tử. Worker restart giữa apply báo gián đoạn, không tự retry; giữ khóa nếu remote commit chưa rõ kết quả. Chuẩn bị cấu trúc không tự chuyển sang Build.

Sau đó lưu cấu hình và kiểm sẵn sàng theo năm bước phía trên. Không cần terminal/Cypher để chuẩn bị cấu trúc thông thường. Không dùng tính năng import tài liệu của OpenSPG thay cho corpus LuậtGT.

### Kết nối deployment và chọn project

Compose cấp ba endpoint nội bộ; credentials vẫn do deployment quản lý. Chọn project trong UI không cần sửa `.env` hoặc recreate Worker mỗi lần:

| Biến | Giá trị |
| --- | --- |
| `KAG_BUILDER_OPENSPG_URL` | `http://openspg-server:8887` |
| `KAG_BUILDER_NEO4J_HTTP` | `http://openspg-neo4j:7474` |
| `KAG_BUILDER_NEO4J_URI` | `bolt://openspg-neo4j:7687` |

Worker chỉ chấp nhận `graph_store` cùng host/port Bolt được cấp. Project ngoài kết nối này hiện **chưa cấp kết nối**, không tự gọi địa chỉ trong catalog. Các biến `KAG_BUILDER_PROJECT_ID`, `KAG_BUILDER_PROJECT_NAME`, `KAG_BUILDER_DATABASE` chỉ còn làm gợi ý đích cho cấu hình cũ khi chưa có lựa chọn lưu; không đổi target của phiên đã tồn tại. `KAG_BUILDER_SERVING_DATABASE` bảo vệ database serving; Compose lấy từ `KAG_DATABASE`. Không đổi biến này, release hoặc binding Chat để thiết lập Builder.

Credentials đọc từ `KAG_NEO4J_USERNAME`/`KAG_NEO4J_PASSWORD` của Worker; không nhận URL/password từ UI. `KAG_OPENSPG_PUBLIC_URL`, `KAG_NEO4J_BROWSER_URL`, `KAG_NEO4J_PUBLIC_BOLT_URL` là URL cho trình duyệt, mặc định localhost; không chứa credentials. Thiếu phiên đăng nhập OpenSPG báo quyền; catalog rỗng, thiếu kết nối và lỗi dịch vụ được phân biệt. Session OpenSPG không lưu vào config/ledger.

Thiếu schema/index: về **Cấu hình → Xem thay đổi**; nút kiểm sẵn sàng không tự sửa. `TARGET_MODEL`: dùng project rỗng hoặc model gốc cùng lịch sử run/checkpoint; không tự drop index hay trộn vector. Khóa ghi: kiểm owner/run; không xóa khóa để ép chạy. Hai project cùng physical database dùng chung khóa. Chưa có project hợp lệ thì Builder giữ chưa sẵn sàng.

### Runner CLI nâng cao

Đường UI tự sinh config/hash/confirmation từ nguồn và đích đã cấp; người dùng không cần tạo `runner.json`. Với CLI hoặc cấu hình cũ, copy [runner.example.json](../kag/config/runner.example.json) ra ngoài repo; template mặc định DENY, cần inputs/hashes/target thật. [runner.py](../kag/runner.py) là nguồn chuẩn validator, từ chối unknown fields.

- `scope`: `C4_3A_MANIFEST_SAMPLE` chỉ NO_OP/replay trên manifest đã pin; `FRESH_SAMPLE` chỉ subset 1–128 nodes, 1–256 edges, batch ≤32, replay. `PRODUCTION` dùng nguồn đã pin với phạm vi ALL/COUNT/PERCENT được chốt trong cấu hình; WRITE cần confirmation gắn đúng project/namespace/ID/plan, backend identity và GraphLock. Không dùng SAMPLE cho full graph.
- `runtime_location`, `endpoints`, `database`, project/name/namespace: explicit và khớp discovery; không fallback endpoint hoặc dùng ID/container cũ. Trong template PRODUCTION/container, `builder-openspg` và `builder-neo4j` là **placeholder DNS cho đích riêng do quản trị viên cài đặt**, cần thay bằng service thực cùng mạng. OpenSPG trong Compose nghe `0.0.0.0:8887` trên mạng internal, truy cập bằng DNS service. Mở cổng quản trị không cấp quyền dùng database serving làm đích Builder. Điều kiện thử biệt lập: [backend identity](backend-identity.md#xác-minh-đường-đi-và-database).
- `write_mode`: NO_OP/WRITE; `vector_policy`: replay/provider trong giới hạn scope. `model_identity=endpoint|model`; PRODUCTION lấy dimension đã kiểm (1–65536), namespace theo project. Các scope SAMPLE cũ vẫn giữ contract 3072 của chúng; replay không fallback provider. Provider config/fallback phải khớp provenance.
- `paths`: inputs và run/lock roots tuyệt đối; roots ngoài repo, không chồng inputs. `input_sha256` bind đúng bytes từng non-null input, không gồm roots. C3 JSONL/`plan.sha256` nằm cạnh manifest.
- `credential_env`: tên biến secrets, không phải giá trị; credentials chỉ trong RAM. Confirmation/proof không tự mở quyền production.

Trong Compose: config `/builder-input/runner.json`, run root `/builder-runs`, lock `/run/kag-locks`; giữ mounts theo [Docker](../docker/README.md#storage-và-secrets).

Quyền Worker nằm ở cấu hình Runner đã kiểm, confirmation đúng nguồn/đích, identity vật lý và GraphLock chung. Các biến `KAG_OPERATIONAL_PROOF`, `KAG_PRODUCTION_WRITE`, `KAG_PROVIDER_EGRESS` chỉ được API kiểm lúc startup; không phải công tắc chặn Worker. Kiểm nguồn không cấp quyền ghi hoặc gọi provider. Provider còn cần credentials và đường mạng deployment cho phép.

## Chạy CLI

**Bước 1:** chuẩn bị config/inputs/credentials và mounts ngoài Git, dùng runtime chuẩn. `/external/runner.json` bên dưới là đường ví dụ, thay bằng config đã chuẩn bị.

**Bước 2:** chọn đúng thao tác:

```sh
python -B -m kag run --config /external/runner.json --run-id sample-run
python -B -m kag resume --config /external/runner.json --run-id sample-run
python -B -m kag verify --config /external/runner.json --run-id sample-run
```

Kết quả: status/artifacts trong run directory. `verify` không sửa graph/index nhưng ghi verification/receipt. Exit 0: hoàn tất; 1: lỗi runtime/transport/provider; 2: bị chặn scope/lock/config/integrity. Đọc `stage/error_code`; không log credentials/source/exception body.

## Source-only validation

[source-only.example.json](../kag/config/source-only.example.json) dùng `SOURCE_ONLY_DRY_RUN/NO_OP`; thay hash zero bằng byte hash thật và đặt run root ngoài repo. Chỉ nhận fields trong template, không endpoints/provider/WRITE.

Luồng source: preflight → plan → source-nodes → source-edges → source-verify → source-complete. Không mở graph/provider/writer; `graph_verified=false`, counters zero. `verify` chỉ nhận source run đã hoàn tất; lock theo run directory.

Validation/resume dùng disk SQLite index, không nạp toàn corpus vào dict. Đặt TMPDIR ngoài repo nếu caller không có run directory. Kiểm semantic hashes/input/golden; không sửa nguồn để qua gate. O(batch) payload không phải cam kết peak RAM của full production vectors.

## Stage và readback

Graph: preflight → plan → vectorize → export-artifact → write-nodes → verify-nodes → write-edges → verify → release. Không cộng counters các stage dùng đơn vị khác nhau.

- Replay kiểm model/dimension/source, provenance/chunk sidecar/checkpoint; thiếu job/vector thì chặn. Provider dùng vectorizer upstream, tắt name generation.
- Export fsync/publish atomic trước ghi. NO_OP không tạo writer; WRITE dùng scoped NativeIntegerKGWriter, node barrier và live backend guard.
- Verify kiểm IDs/payload, native Integer sau outer decode, vectors hữu hạn, duplicate/extra/missing/endpoints/provenance và bốn VECTOR indexes ONLINE. Hai scans/fingerprint phát hiện graph đổi; chỉ canonical signed zero, không làm tròn vectors.

## Resume, trạng thái và lock

Status Worker hiện dùng `builder-control-v3`: tiến trình từng stage đọc từ ledger, kèm run, kế hoạch, cấu hình, model và physical database; có thêm trạng thái Bỏ phiên/Xóa dữ liệu. Kết quả chỉ xuất hiện sau khi đủ stages và xác minh graph đạt; số lượng kế hoạch không thay số lượng thực kiểm. Poll không gọi lại provider hoặc quét graph. Sau restart, kết quả đã hoàn tất vẫn đọc được; phải kiểm nguồn/sẵn sàng lại trước Build hoặc Resume.

Java và frontend nhận v1/v2/v3 để nâng cấp đồng bộ. V1 chỉ có tiến độ stage hiện tại, không có bảng lịch sử hoặc kết quả run đã xác minh; v2 có chi tiết tiến trình/kết quả; v3 bổ sung trạng thái `ABANDONED`/`CLEARED`. Khi triển khai từng phần, nâng backend/frontend tương thích v3 trước Worker v3. Release của Runner không tự kích hoạt Chat.

Với cấu hình sản phẩm, Build/Resume gửi `If-Match: "<revision>"` của cấu hình đã xác nhận. Worker trả 409 khi revision thay đổi hoặc thiếu header; tải lại và kiểm sẵn sàng trước khi xác nhận lại. Stop không cần header. Refresh/timeout chỉ đọc trạng thái, không tự gửi lại thao tác.

Run chứa ledger/expected SQLite, checkpoint, batches/export, `status.json`, `events.jsonl`, `batches.jsonl`, `receipt.json`. Status/receipt atomic, audit append-only có hash chain/outbox; tail hỏng/torn bị chặn, không truncate.

Resume giữ config/input/target/model/batch boundaries, kiểm artifacts và đọc lại node barrier/graph. Batch CONFIRMED không gửi lại writer/vectorizer. Graph INTENT chưa confirmed chỉ đọc lại; thiếu/khác/không chắc thì BLOCKED, **không resend mù sau timeout**.

`graph_writes/embedding_calls` đếm durable dispatch intents, không phải ACK hay số mutations. Crash có thể đếm dư một; timeout không xác nhận remote completion.

GraphLock khóa theo **physical databaseID**, mọi writer cùng DB trên một host dùng chung volume local `KAG_GRAPH_LOCK_VOLUME`. Kernel kiểm mount disk writable đúng root volume; private directory/tmpfs/readonly bị chặn. Không phải distributed fencing, không chặn admin/writer ngoài cơ chế.

Chỉ owner release khi thoát sạch; crash giữ stale lock. Không force-unlock hoặc takeover theo heartbeat. Trước phục hồi thủ công, kiểm owner/process/run/target và tình trạng ghi; không sửa ledger/receipt/hash để ép tiếp tục.

Receipt ghi identity/counters/artifact/audit anchors, không cấp serving authority hoặc quyền production. Resume tạo session mới và xác minh target live. Bảo trì giữ run/state/lock theo [UPDATE](UPDATE.md); [tests](../tests/README.md) kiểm offline bằng fixtures.

Builder ghi nhận namespace/model/dimension theo phiên. Đường Chat/retrieval của release cũ vẫn giữ contract đã pin; hoàn tất Builder không đổi release hoặc chứng minh Chat dùng được graph mới.
