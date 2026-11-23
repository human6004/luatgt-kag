# Định nghĩa benchmark chatbot WebApp

## Phạm vi

Dataset mới phục vụ hai thực nghiệm: khả năng trả lời luật (C1–C7) và tính ổn định
trước cách diễn đạt/ngữ cảnh. Mỗi dòng là một lượt người dùng. Đây là pilot,
không phải benchmark pháp lý chính thức. CSV và JSON chứa cùng dữ liệu, đúng 13
cột sau, cùng thứ tự. Các ô có kiểu JSON phải chứa JSON hợp lệ, không phải Python repr.

## 13 cột

| # | Tên | Kiểu / miền giá trị | Ý nghĩa | Ví dụ |
|---|---|---|---|---|
| 1 | `qid` | Chuỗi không rỗng, duy nhất toàn bộ dataset | Định danh lượt hỏi | `Q001` |
| 2 | `case_group` | Chuỗi không rỗng | Nhóm câu có cùng dữ kiện pháp lý và yêu cầu trả lời, khác cách diễn đạt. Không gộp biến thể thay đổi dữ kiện hoặc yêu cầu đầu ra. | `PRIORITY_DEF` |
| 3 | `conversation_id` | Chuỗi không rỗng | Mã hội thoại trong dataset; độc lập với UUID WebApp | `CHAT01` |
| 4 | `turn_index` | Số nguyên từ 1, liên tiếp trong mỗi hội thoại | Thứ tự gọi API; không trùng, không thiếu lượt; các dòng hội thoại phải liền nhau | `2` |
| 5 | `question` | Chuỗi không rỗng, tối đa 4000 UTF-16 units theo ChatRequest | Nguyên văn câu hỏi gửi chatbot; không kèm đáp án/gold/nhãn | `Còn người đi bộ thì sao?` |
| 6 | `category` | Một trong `C1`…`C7` | Nhiệm vụ chính cần đánh giá | `C1` |
| 7 | `question_attributes` | Object JSON có đúng 3 trường bên dưới | Đặc điểm cách diễn đạt, nội dung và quan hệ hội thoại; thay cho variation | Xem ví dụ dưới |
| 8 | `reasoning_level` | `direct`, `single_step`, `multi_step` | Mức suy luận yêu cầu, không phải số bước nội bộ model thực hiện | `multi_step` |
| 9 | `legal_reference_date` | Ngày `YYYY-MM-DD` | Mốc tham chiếu pháp luật cho đáp án chuẩn, không phải ngày ban hành | `2026-11-18` |
| 10 | `expected_behavior` | `ANSWER`, `CLARIFY`, `ABSTAIN` | Trả lời, hỏi làm rõ, hoặc chưa đủ căn cứ | `ANSWER` |
| 11 | `expected_answer` | Chuỗi không rỗng | Đáp án tham khảo, hoặc nội dung hỏi lại/từ chối; không yêu cầu trùng cách diễn đạt | `Người đi bộ được phép đi trên vỉa hè hoặc lề đường.` |
| 12 | `required_facts` | Mảng JSON không rỗng gồm các chuỗi | Các ý bắt buộc, mỗi ý chấm riêng; với CLARIFY ghi thông tin cần làm rõ, ABSTAIN ghi giới hạn cần nêu | `["Không tự đưa ra con số khi thiếu căn cứ."]` |
| 13 | `gold_evidence` | Mảng JSON các object căn cứ; ANSWER bắt buộc không rỗng | Nguồn đối chiếu cho gold; không khẳng định node/cạnh đã tồn tại trên graph phục vụ | Xem bên dưới |

### Category: loại nhiệm vụ

| Giá trị | Tên | Quy tắc gán nhãn |
|---|---|---|
| C1 | Tra cứu biển báo | Ý nghĩa, phạm vi, đối tượng và ngoại lệ của biển |
| C2 | Tra cứu quy định pháp luật | Định nghĩa, nghĩa vụ, điều kiện hoặc nội dung điều khoản |
| C3 | Tra cứu văn bản pháp lý | Xác định văn bản chứa quy định được hỏi |
| C4 | Liên kết biển báo–quy định | Cần cả thông tin biển và điều khoản pháp luật liên quan |
| C5 | Tình huống áp dụng pháp luật | Áp dụng điều kiện/ngoại lệ vào tình huống cụ thể, gồm mức xử phạt |
| C6 | So sánh và phân biệt | Phải chỉ rõ điểm giống/khác theo tiêu chí câu hỏi |
| C7 | Tổng hợp nhiều nguồn | Kết hợp ít nhất hai căn cứ có vai trò khác nhau, không chỉ lặp nội dung |

Chọn một category theo mục tiêu chính. Ví dụ C4 có nhiều nguồn vẫn gán C4 khi
trọng tâm là liên kết biển–quy định. Câu ngoài corpus gán nhóm yêu cầu gần nhất,
đồng thời `expected_behavior=ABSTAIN`; không cần category thứ tám.

### Question attributes: ba trục riêng trong một cột

```json
{
  "expression_tags": ["noisy"],
  "content_tags": [],
  "conversation_type": "follow_up"
}
```

#### Expression tags — cách diễn đạt

`expression_tags` là mảng có ít nhất một nhãn, không trùng, có thể chọn nhiều
nhãn. `standard` dùng riêng, không kết hợp với các nhãn khác.

| Giá trị | Định nghĩa | Ví dụ |
|---|---|---|
| `standard` | Câu hỏi rõ ràng, viết đầy đủ, đúng chính tả, cách diễn đạt thông thường. | “Biển P.102 có ý nghĩa gì?” |
| `noisy` | Câu hỏi không dấu, viết tắt hoặc có lỗi gõ/sai chính tả. | “bien P.102 co y nghia j?” |
| `verbose` | Diễn đạt dài dòng, lặp ý hoặc chứa thông tin thừa. | Kể dài về chuyến đi trước khi hỏi ý nghĩa một biển báo. |

Miền giá trị chỉ gồm `standard`, `noisy`, `verbose`. `noisy` gộp các dạng lỗi
trình bày, không phân biệt điểm riêng cho từng loại lỗi. Với `verbose`, phải chỉ
ra được phần có thể bỏ mà không thay đổi dữ kiện pháp lý và yêu cầu trả lời;
câu dài vì chứa nhiều dữ kiện cần thiết không tự động là `verbose`.

#### Content tags — đặc điểm nội dung

`content_tags` là mảng nhãn không trùng, có thể chọn nhiều nhãn. Để `[]` nếu câu
hỏi không có các đặc điểm bên dưới.

| Giá trị | Định nghĩa | Ví dụ |
|---|---|---|
| `false_premise` | Câu hỏi chứa giả định hoặc khẳng định sai mà chatbot cần nhận diện và sửa; người biên soạn phải đối chiếu nguồn để xác định tiền đề sai. | “Biển P.102 chỉ cấm ô tô, xe máy vẫn được vào đúng không?” |
| `underspecified` | Thiếu dữ kiện cần thiết để đưa ra kết luận xác định, sau khi đã xét cả lịch sử hội thoại. | “Tôi chạy quá tốc độ thì phạt bao nhiêu?” nhưng chưa rõ loại xe và mức vượt. |
| `multi_request` | Có từ hai yêu cầu trả lời riêng biệt trong một lượt hỏi. | “Hành vi này phạt bao nhiêu tiền và trừ mấy điểm GPLX?” |

Một tình huống dài có nhiều dữ kiện nhưng chỉ hỏi một kết luận không tự động là
`multi_request`. Câu hỏi tiếp không bị gán `underspecified` nếu lịch sử đã cung
cấp đủ thông tin.

#### Conversation type — quan hệ với hội thoại

`conversation_type` là một chuỗi, chọn đúng một giá trị. Lượt 1 luôn
`standalone`; lượt sau chọn loại chính theo mục tiêu kiểm thử.

| Giá trị | Định nghĩa | Ví dụ |
|---|---|---|
| `standalone` | Lượt mở đầu, tự đủ nghĩa, không cần hội thoại trước. | “Biển P.102 có ý nghĩa gì?” |
| `follow_up` | Hỏi tiếp, bổ sung hoặc thu hẹp vấn đề đang trao đổi. | “Còn người đi bộ thì sao?” sau khi hỏi về biển P.102. |
| `correction` | Đính chính hoặc thay thế dữ kiện đã nêu trước đó. | “Tôi nói nhầm, tôi đi xe máy chứ không phải ô tô.” |
| `topic_switch` | Chuyển sang vấn đề khác trong cùng hội thoại; câu có thể tự đủ nghĩa về nội dung. | Đang hỏi biển báo, chuyển sang hỏi giấy tờ cần mang. |

Nếu một lượt vừa đính chính vừa hỏi tiếp, chọn `correction` khi mục tiêu chính là
kiểm tra chatbot có cập nhật dữ kiện đúng hay không.

Ba nhóm nhãn mô tả đầu vào, không quyết định đáp án hoặc hành vi mong đợi. Các
phần đó vẫn nằm ở `expected_answer` và `expected_behavior`. Nhãn không dấu, viết
tắt hoặc khẩu ngữ không tự có nghĩa chatbot phải hỏi lại hay từ chối.

### Reasoning level

- `direct`: lấy thông tin trực tiếp từ một căn cứ.
- `single_step`: áp dụng một quy tắc vào tình huống, sửa một giả định sai hoặc
  giải quyết một tham chiếu hội thoại trước khi tra cứu.
- `multi_step`: cần nối từ hai căn cứ/vai trò độc lập; ANSWER phải có ít nhất hai
  `requirement_group` khác nhau. Số citations không chứng minh quá trình suy luận.

Một phép so sánh trực tiếp các trường hợp trong cùng một quy tắc có thể là
`single_step`; không tự gán mọi câu C6 là `multi_step`. Phân biệt yêu cầu liên kết
căn cứ để rút kết luận với việc chỉ có nhiều đoạn trích hoặc câu hỏi dài.

Bộ 100 dòng phiên bản balanced-v2 đặt mục tiêu direct/single_step/multi_step là
40/30/30. Đây là phân bố thiết kế thực nghiệm, không phải tỷ lệ tối ưu đã được
chứng minh. Các nhóm cách diễn đạt dùng tình huống khác nhau, không phải bộ cặp
đối chứng; chênh lệch điểm theo expression không cô lập ảnh hưởng của cách viết.

### Gold evidence và nguồn thay thế

```json
[
  {
    "doc_id": "36_2024_QH15",
    "unit_id": "36_2024_QH15::D2::K4",
    "sign_id": null,
    "field": "text",
    "quote": "được cắm biển báo hiệu đường ưu tiên",
    "source_url": "https://congbao.chinhphu.vn/...",
    "requirement_group": "definition"
  }
]
```

URL trên minh họa cấu trúc; dữ liệu thực phải lấy URL nguyên bản từ
`data/processed/meta/documents.jsonl`. Validator đối chiếu chính xác URL đó.

Mỗi object có đúng các trường trên. `doc_id` bắt buộc. `unit_id`, `sign_id` có thể
null. Với biển chọn `sign_id`, `field=moTa` hoặc `ten`; điều khoản chọn `unit_id`,
`field=text`; cấp văn bản dùng `field=title`. Không dùng anchor unit của biển
để thay thế đơn vị chứa nguyên văn mô tả. Nếu cần cả phụ lục và biển thì ghi hai
object. Khi có cả unit/sign ID thì binding phải đúng corpus.

`requirement_group` là mã **nhu cầu căn cứ**. Nhiều nguồn có cùng mã là các phương án
thay thế; chỉ cần một phương án đủ hỗ trợ. Nguồn có mã khác là nhu cầu độc lập.
Như vậy nguồn tương đương không bị bắt trích đồng thời. `quote` phải là đoạn
nguyên văn không rỗng trong field nguồn; có thể gồm xuống dòng. Không dùng offset
để buộc chatbot trích đúng độ dài đoạn do người biên soạn chọn.

Nguồn kiểm tra: `meta/documents.jsonl`, `units/units.jsonl`, `signs/signs.jsonl`
trong `data/processed/`; bản đọc Markdown tại `data/processed/documents/` và URL
gốc phục vụ review. Validator xác nhận ID/URL/quote tồn tại, **không tự xác nhận
hiệu lực pháp lý, tính đầy đủ của đáp án hoặc sự tồn tại của cạnh Neo4j**.
CLARIFY/ABSTAIN có thể để gold rỗng; kết luận không đủ dữ liệu là tương đối với
phiên bản corpus được chọn, cần kiểm lại nếu corpus thay đổi.

### Ngày và multi-turn

API WebApp đang dùng ngày hiện tại của Việt Nam, không nhận ngày tùy chọn.
Runner không gửi `legal_reference_date` vào field API không tồn tại và không tự
chèn ngày vào câu hỏi. Ngày khác ngày chạy được ghi `DATE_UNSUPPORTED`, không gọi
model và không tính thành lỗi API. Muốn thực nghiệm lịch sử phải có đường phục vụ
hỗ trợ phù hợp trước; không thay ngày dataset chỉ để ép câu cũ chạy được.

Ngày vi phạm/ngày phát hiện và tình trạng đã kết thúc/còn tiếp diễn phải nằm rõ
trong tình huống nếu có ý nghĩa pháp lý; một ngày tham chiếu không thay thế các dữ kiện đó.

Mỗi câu độc lập có `conversation_id` riêng, `turn_index=1`. Multi-turn dùng chung
mã, index 1,2,3… Runner gửi lượt 1 với `conversationId=null`, rồi dùng UUID gốc từ
SSE cho lượt sau. Lịch sử là phản hồi **thực tế**, không phải expected_answer.
Nếu lượt trước lỗi kỹ thuật thì các lượt phụ thuộc ghi `DEPENDENCY_FAILED`.

## Metrics, rubric và cách tính

Tỷ lệ ở [0,1], không phải phần trăm; report có thể nhân 100 khi trình bày.
Mỗi giá trị giữ numerator/denominator/method/reason. Thiếu dữ liệu là JSON null
(CSV ô metrics chứa null), report ghi `N/A`, không gán 0. Các tỷ lệ tổng hợp bằng
tổng numerator / tổng denominator của mẫu hợp lệ; luôn báo số câu N/A và lý do.
Các nhóm tag chồng lấn, không cộng số mẫu của các nhóm để ra overall.

### 1. Chất lượng và hành vi chatbot

Bốn metric chính là Correctness, Completeness, Hallucination Rate và Behavior
Accuracy. Task Success Rate là kết quả tổng hợp từ cùng phiếu review, không chấm
thêm một lần. Relevance chỉ là tiêu chí review phụ để tính Task Success, không
xuất thành metric riêng.

| Metric | Định nghĩa / công thức | Dữ liệu, phương pháp | Chiều tốt |
|---|---|---|---|
| Correctness | Số đáp án có kết luận và nội dung đúng / số đáp án đã review có kết luận chắc chắn | Human review: đối chiếu đáp án, facts, ngữ cảnh và nguồn; không chấm bằng độ giống từ | Cao |
| Completeness | Tổng số required_facts được đáp ứng / tổng số required_facts đã chấm trong các câu được review đầy đủ | Human review từng fact. Câu có fact chưa chắc chắn giữ N/A toàn bộ completeness | Cao |
| Hallucination Rate | Số khẳng định thực tế/pháp lý không được nguồn và ngữ cảnh hỗ trợ / tổng khẳng định đã kiểm tra | Human review tách claims; nguồn mâu thuẫn cũng là unsupported. Không có claim hoặc chưa kiểm hết: N/A | Thấp |
| Behavior Accuracy | Số lượt có ANSWER/CLARIFY/ABSTAIN đúng gold / số lượt quan sát được hành vi | Rule; map ANSWERED→ANSWER, CLARIFY→CLARIFY, KAG_ABSTAINED→ABSTAIN | Cao |
| Task Success Rate | Số lượt đúng hành vi, correctness=true, relevance=true và mọi required_fact=true / số lượt có thể xác định thành/bại | Combined. Sai hành vi, fact sai, correctness/relevance false, hoặc lỗi API: thất bại. Chưa review đủ mà chưa chứng minh thất bại: N/A | Cao |

Không xuất False Premise Handling Accuracy, Unanswerable Handling Accuracy hoặc
Multi-turn Success Rate trong bộ điểm này. Vẫn giữ nguyên câu hỏi và nhãn để
phân tích các metric đã chọn theo `false_premise`, expected ABSTAIN và loại lượt
hội thoại. Điểm theo loại lượt không phải tỷ lệ thành công của cả hội thoại.

Không tính unavailable thành abstain: HTTP 200 SSE có state UNAVAILABLE vẫn là
lỗi ứng dụng; KAG_ABSTAINED là phản hồi hành vi hợp lệ.
Lượt SENDING/PROCESSING/INTERRUPTED chưa đối soát có kết quả cuối chưa xác định:
Task Success/API Success giữ N/A, không quy thành thất bại. Timeout
đã quan sát vẫn tính được; sau resume đánh giá lại trên kết quả đã khôi phục.

### 2. Citation của câu trả lời chatbot

Hai metric citation được chấm trong bước 03 trên kết quả API chat đã lưu;
không cần mở giao diện trình duyệt. Đây là đối chiếu với gold và corpus, không
phải đánh giá thứ hạng truy xuất.

| Metric | Công thức / điều kiện | Phương pháp | Chiều tốt |
|---|---|---|---|
| Citation Precision | Citations đúng / tổng citations dự đoán, dedup theo ID/field/quote | Source comparison. Đúng khi ID/field khớp gold, chứa gold quote và toàn bộ quote dự đoán tồn tại nguyên văn trong field corpus. Citation sai cấu trúc tính sai; không citation thì N/A | Cao |
| Citation Recall | Số requirement_group có ít nhất một citation hỗ trợ / tổng requirement_group | Alternative-aware; thiếu citation khi gold khác rỗng cho recall=0 | Cao |

Chỉ chấm citation khi gold mong đợi ANSWER và quan sát được một hành vi cuối
ANSWER/CLARIFY/ABSTAIN; trường hợp khác giữ N/A. Citation matching không chứng
minh nguồn áp dụng đúng pháp luật tại ngày tham chiếu; human review kiểm phần đó.

### Đánh giá Retriever riêng

Giữ cả bốn metric dưới cho thực nghiệm Retriever riêng. Không xuất chúng dưới
dạng N/A trong kết quả chấm chatbot của bước 03–05. Cần thu ranking thực tế,
chốt K/cutoff và cấp identity (document/unit/sign) trước khi chạy; gold relevance
phải cùng cấp với danh sách xếp hạng. Ưu tiên Recall@K và MRR@K; Hit@K và
Precision@K bổ sung khả năng tìm được nguồn và mức nhiễu.

| Metric | Công thức / điều kiện | Phương pháp | Chiều tốt |
|---|---|---|---|
| Hit@K | 1 nếu top K có ít nhất một relevant identity, ngược lại 0; trung bình trên câu có gold | Chỉ tính khi có ranking nguồn đúng giai đoạn, K công bố trước và cùng cấp ID | Cao |
| Precision@K | Số relevant IDs trong top K / K | Ranking dedup; slot thiếu tính không relevant; cần biết K và kết quả top K đầy đủ | Cao |
| Recall@K | Số relevant IDs trong top K / tổng relevant gold IDs | Cần gold relevance ở cùng cấp ranking | Cao |
| MRR | Trung bình 1/rank của relevant ID đầu tiên; không có relevant trong danh sách đã công bố thì 0 | Cần ranking và phạm vi cutoff được khai báo; nếu cutoff hữu hạn phải ghi rõ MRR@cutoff | Cao |

API `/api/chat/stream` không trả ranking/top K. Runner hiện tại không thực hiện
thực nghiệm Retriever riêng; đổi base URL không tự bổ sung ranking hoặc cách
chấm. Không lấy thứ tự citations làm ranking và không gọi Retriever riêng rồi
gán kết quả đó cho lần chat đã lưu. Phần này giữ định nghĩa, chưa bổ sung runner mới.

### 3. Hiệu năng API chat

Chỉ tiêu chính là API Success Rate và P50/P95 Latency; Timeout Rate là chỉ tiêu
bổ sung để chẩn đoán. Không xuất Mean Latency hoặc Error Rate. Error Rate với
cùng mẫu số kết quả cuối đã xác định là phần bù của API Success Rate.

| Metric | Công thức / dữ liệu | Chiều tốt |
|---|---|---|
| P50/P95 Latency | Quantile p=0.5/0.95, nội suy tuyến tính trên dãy elapsed tăng dần | Thấp |
| API Success Rate | Số lượt kết thúc ANSWERED/CLARIFY/KAG_ABSTAINED / số lượt có attempts>0 và xác định được kết quả cuối | Cao |
| Timeout Rate | Số lượt có timeout / số lượt có attempts>0 | Thấp |

Đơn vị đo là **lượt hỏi logic**, không phải số request vật lý. `attempts` lưu retry.
Elapsed tính từ trước POST đầu đến kết quả cuối/lỗi, gồm backoff 429, không gồm
đăng nhập, khoảng nghỉ giữa câu và source validation. Tất cả elapsed đo được đều
được dùng, cả lỗi/timeouts. Khi resume khôi phục terminal từ history, không biết
thời điểm hoàn tất thật nên latency=null. Cờ timeout đã quan sát vẫn được giữ,
do đó lượt khôi phục thành công có thể vừa API success vừa từng timeout.

Bước 03 giữ `latency_ms` cho từng lượt làm dữ liệu đo để bước 04 tính P50/P95
toàn bộ và từng nhóm. Đây không phải Mean Latency hoặc metric tổng hợp riêng.
P50/P95 hiện gộp cả lượt thành công, lỗi và timeout có elapsed đo được; lượt lỗi
nhanh có thể làm phân vị giảm. Luôn đọc cùng API Success, Timeout và số mẫu.
Runner gọi tuần tự và có khoảng nghỉ: không đo throughput, tải đồng thời, thời
gian render UI hoặc thời gian tới token đầu tiên; latency không phải thời gian
riêng của model.

### Human review (rubric_version=1)

Mặc định không dùng LLM-as-a-Judge; không phát sinh cuộc gọi chấm điểm provider.
Step 3 xuất phiếu JSON gắn `run_id`, `dataset_id`; người chấm điền tên và mỗi qid:

```json
{
  "qid": "Q001",
  "correctness": null,
  "relevance": null,
  "fact_support": [null, null, null],
  "claim_count": null,
  "unsupported_claim_count": null,
  "rationale": "Ghi kết luận, nguồn đối chiếu và lý do chưa chắc chắn."
}
```

- Correctness=true khi kết luận và các phát biểu pháp lý đúng với ngữ cảnh/ngày;
  false khi có sai sót thực chất; không đủ căn cứ quyết định thì null.
- Relevance=true khi đáp đúng yêu cầu (hoặc hỏi lại/từ chối phù hợp), false khi
  lạc đề; không chắc thì null. Chỉ dùng để tính Task Success, không xuất điểm riêng.
- `fact_support` đúng độ dài/thứ tự required_facts; true khi ý được đáp ứng đúng,
  false khi thiếu/sai, null khi cần kiểm lại. Không bắt diễn đạt giống mẫu.
- `claim_count` đếm khẳng định thực tế/pháp lý riêng biệt, không đếm câu hỏi làm rõ,
  lời chào. Chỉ điền cùng `unsupported_claim_count` khi đã kiểm toàn bộ claims;
  0 ≤ unsupported ≤ total. Nếu không có claims thì 0/0 tạo N/A, không thành 0% bịa.
- Phiếu mới không yêu cầu `false_premise_handled`; bước 03 vẫn nhận trường này
  trong phiếu rubric_version=1 cũ để tương thích nhưng không dùng tính điểm.
- Rationale bắt buộc, dẫn nguồn/ý đã đối chiếu. Ca null cần người chấm kiểm lại
  hoặc người thứ hai review; không ép ra điểm. Lưu phiếu review gốc và chạy lại
  step 3 để có bản đánh giá mới. Không sửa kết quả cũ.

Muốn bổ sung LLM judge sau này phải có adapter/rubric/model settings, response
gốc và cơ chế review verdict không chắc chắn; runner này chưa có chế độ đó.
