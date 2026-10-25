# Đợt 2 — Chỉ bắt đầu được trận mà thuật toán đã chọn

*Bản đề xuất để duyệt. Chưa sửa code. Tiếp nối Đợt 1 (nhánh `fix/scheduler-silent-failures`) và báo cáo [audit.md](audit.md).*

## 1. Mục tiêu

Người vận hành **tin vào thuật toán và không tự chọn trận**. Desk chỉ cho bắt đầu đúng trận mà lịch đã xếp cho sân đó, và chỉ khi trận đó thật sự đánh được.

Đợt 2 thực hiện nguyên tắc này bằng ba việc:

1. đóng các "cửa sau" cho phép bắt đầu trận ngoài lịch (mục 5 và mục 8);
2. để màu "Ready" không còn hiện ra khi trận chưa được phép đánh (mục 6);
3. để server tự từ chối những lần bắt đầu sai, kể cả khi giao diện có lỗi (mục 5).

**Không** nằm trong đợt này: kiểm tra khi bắt đầu sớm (mục 7, hoãn), thiết kế lại card, đề xuất gỡ trận kẹt, thẻ quyết định cuối ngày.

## 2. Vì sao vẫn cần sau Đợt 1

Đợt 1 sửa lỗi khiến thuật toán **bỏ sót** trận. Nhờ đó trận sẵn sàng gần như luôn có giờ trong vài giây. Nhưng Đợt 1 không đóng những đường cho phép người vận hành **tự bắt đầu một trận khác**. Hiện còn bốn đường như vậy:

| # | Đường bắt đầu trận ngoài lịch | Ví dụ trong giải vừa rồi | Đợt 1 có đóng không? |
| --- | --- | --- | --- |
| A | Card **sân trống** hiện "Place on this court" cho trận đầu tiên trong danh sách chưa có giờ. Bấm vào là bắt đầu trận đó ngay trên sân này. | 12:14 XD C r1 s1 và 12:31 MS A r1 s2. Lần 12:14 đã gây ra chuỗi sự cố ở sân 2. | Không. Danh sách chỉ hiếm khi có trận hơn. |
| B | **Trang Scores** mở được bất kỳ trận nào và có nút "▶ Start match". Trang này không chạy bước kiểm tra trước khi bắt đầu. | Không có trong dữ liệu (chỉ dùng Desk). | Không |
| C | **Dời sân và giờ bằng tay** trong dialog trận trên Desk: kéo một trận sang sân trống, nó trở thành trận kế tiếp, rồi bắt đầu. | 16:55 kéo XD r2-5 sang sân 8 (rồi tự hoàn tác). | Không |
| D | **Server** nhận lệnh bắt đầu với mọi trận đang `scheduled`, kể cả trận chưa có giờ. Tham số sân còn **ghi đè** sân đã xếp. | Là lý do A, B, C làm được. | Không |

Ngoài ra còn một chỗ màu card nói sai:

| # | Vấn đề | Ví dụ |
| --- | --- | --- |
| E | Card hiện **xanh "Ready"** cho một trận mà trận tiên quyết của nó vẫn đang đánh. Phần tính trạng thái sẵn sàng (`getMatchReadiness`) chỉ xét VĐV đang đánh và VĐV đang nghỉ, không xét trận tiên quyết. | 16:34 ngày 1: WS makeup-2 được bắt đầu trong khi WS r2-1 và r2-2 (thuộc danh sách tiên quyết của nó) đang đánh. |

## 3. Các thay đổi

### 3.1 Bỏ "Place on this court" trên card sân trống (đường A)

**Hiện tại:** khi một sân không có trận nào xếp, card lấy trận đầu tiên trong danh sách "ready, unassigned" và mời bắt đầu nó ở sân này.

**Sau khi sửa:**
- Card sân trống chỉ hiện trạng thái *Idle* ("Nothing queued"), không còn trận nào để mở.
- Nếu đang có trận sẵn sàng mà chưa có giờ, **thông báo đỏ phía trên bảng sân của Đợt 1** là nơi duy nhất nói về chúng. Thông báo kèm link sang trang Schedule.
- Desk không còn cách nào bắt đầu một trận chưa có giờ.

**Hệ quả cần chấp nhận:** một trận mà thuật toán thật sự không xếp được (ví dụ không kịp trước giờ đóng cửa của ngày cuối) sẽ **không bắt đầu được từ Desk**. Muốn đánh nó, người vận hành phải vào Schedule và làm một trong hai việc: rebuild (rebuild được phép cho ngày cuối chạy quá giờ), hoặc đổi giờ đóng cửa của ngày rồi để hệ thống tự xếp lại. Điều này đúng với nguyên tắc thuật toán quyết định, nhưng thêm một bước khi gặp tình huống cuối ngày.

**Phạm vi sửa:**
- `desk.tsx`: bỏ `readyUnassigned` ra khỏi `target` của card, bỏ dòng "Ready to place: …" và chữ "Place on this court".
- Bộ dữ liệu giả lập cho test (`e2e/fixtures/desk-mock.ts`) đang cố tình có một trận chưa có giờ để kiểm tra trạng thái này. Cần đổi lại để test xác nhận rằng sân trống **không** mở được trận đó.
- Trang giới thiệu (landing) không dùng chữ này, nên không cần sửa.

### 3.2 Bỏ nút Start trên trang Scores (đường B)

**Hiện tại:** trang Scores dùng chung dialog trận với Desk (`MatchOperationsDialog`). Với trận chưa bắt đầu, dialog hiện "▶ Start match" mà không kiểm tra gì ở phía giao diện.

**Sau khi sửa:**
- Trên trang Scores, trận chưa bắt đầu chỉ hiển thị để xem. Không có nút Start, kèm một dòng chỉ dẫn: "Start it from the Desk".
- Nhập kết quả và sửa kết quả trên trang Scores **giữ nguyên**.

**Phạm vi sửa:** thêm một tuỳ chọn cho dialog (ví dụ `allowStart`). Desk bật tuỳ chọn này, Scores không bật.

**Câu hỏi cho bạn:** có ai cần bắt đầu trận từ trang Scores không, ví dụ một người phụ trách ghi điểm riêng? Nếu có thì không bỏ hẳn, mà chỉ cho bắt đầu trận kế tiếp của sân trên trang đó.

### 3.3 Bỏ dời sân và giờ bằng tay khỏi Desk (đường C, mục 8)

**Hiện tại:** dialog trận trên Desk có phần chọn sân và giờ, kèm nút "Check constraints and update" (gọi `reschedulePlacementMatch`).

**Sau khi sửa:**
- Phần này bị gỡ khỏi Desk.
- Hàm và RPC phía sau **giữ nguyên**, vì có thể còn dùng ở nơi khác hoặc dùng lại sau này. Đợt này chỉ bỏ giao diện.
- Dời trận bằng tay, nếu cần, làm qua Schedule (rebuild, đổi setting).

**Hệ quả:** khi một sân gặp sự cố, Desk không còn cách tự chuyển trận. Cách xử lý là bỏ sân đó khỏi ngày trong Schedule rồi rebuild. (Đưa `reassign_court_matches` lên giao diện là việc riêng, chưa nằm trong đợt này.)

### 3.4 Server từ chối những lần bắt đầu sai (đường D)

**Hiện tại:** `start_placement_match(p_match_id, p_court_id)` và `start_tier_draw_match(...)` bắt đầu mọi trận đang `scheduled`, rồi đặt `court_id = COALESCE(p_court_id, court_id)`.

**Sau khi sửa (migration mới):** hai hàm này từ chối kèm thông báo rõ ràng khi:

| Điều kiện | Thông báo (gợi ý) |
| --- | --- |
| Trận chưa có `scheduled_time` hoặc `court_id` | "This match has no court and time yet. Place it from the Schedule before starting it." |
| `p_court_id` được truyền và khác sân đã xếp | "This match is scheduled on Court N. Start it there." |

**Không** đưa vào server: kiểm tra "đây có phải trận kế tiếp của sân không". Lý do:
- Quy tắc này phức tạp (ai là trận kế tiếp khi giờ bằng nhau, khi có trận đã quá giờ).
- Giao diện đã bảo đảm điều đó sau 3.1–3.3.
- Server chỉ cần chặn những trường hợp chắc chắn sai.

**Cần kiểm tra trước khi sửa:** các integration test đang gọi hai hàm này (`start-match-checks`, `placement-feeders`, `live-reflow`) có bắt đầu trận chưa có giờ hay không. Nếu có, phải cho những trận đó có giờ trong phần chuẩn bị dữ liệu của test.

**Nằm trong vùng rủi ro cao** (RPC và database), nên phải chạy đủ các bước kiểm tra, cộng thêm integration test trên Supabase local.

### 3.5 Không hiện "Ready" khi trận tiên quyết chưa xong (vấn đề E, mục 6)

**Hiện tại:** card xét VĐV đang đánh ở sân khác, rồi VĐV đang nghỉ. Nếu qua cả hai thì hiện "Ready".

**Sau khi sửa:**
- Thêm một bước: nếu có trận tiên quyết chưa `reported`/`walkover`, card hiện **trạng thái bị chặn** với lý do *"Waiting for {trận} to finish"*. Nút Start bị khoá, giống như khi VĐV đang ở sân khác.
- Trận tiên quyết đã `void` thì không chặn, giống quy tắc phía server.
- Chỉ đổi phần chữ lý do và trạng thái chặn đã có sẵn, không thiết kế lại card.

**Phạm vi sửa:** `getMatchReadiness` / `deriveCourtState` trong `desk.ts`. Mô hình trận trên Desk (`DeskMatchModel`) cần thêm `prerequisiteIds`, lấy từ `prerequisite_ids` khi dựng dữ liệu ở `desk-matches.ts`.

**Tần suất:** thấp, vì chỉ trận makeup-2 có trận tiên quyết. Nhưng đây là chỗ màu card nói sai, nên sửa luôn.

**Câu hỏi cho bạn:** chặn hẳn hay chỉ cảnh báo? Đề xuất là **chặn**, vì đây là luật của thể thức, và đối thủ của trận makeup đã cố định nên chờ thêm vài phút không gây thiệt hại.

## 4. Không làm trong đợt này

| Mục | Lý do |
| --- | --- |
| Mục 7: kiểm tra khi bắt đầu sớm | Lần bắt đầu sớm gây hại duy nhất (12:44) chỉ gây hại vì WD A đã kẹt sẵn, mà Đợt 1 đã loại bỏ nguyên nhân đó. Người vận hành được quyền cho bắt đầu sớm. Chờ dữ liệu giải thật. |
| `block_start_on_short_rest` | Đã bỏ theo quyết định của bạn: người vận hành tự quyết việc bắt đầu sớm. |
| Đưa `reassign_court_matches` lên giao diện | Việc riêng (xử lý sân hỏng), chưa chốt. |
| Đề xuất gỡ trận kẹt, thẻ quyết định cuối ngày, làm tròn giờ công bố | Đợt 3. |

## 5. Người vận hành sẽ thấy gì khác

| Tình huống | Trước | Sau |
| --- | --- | --- |
| Sân trống, có trận sẵn sàng mà chưa có giờ | Card mời "Place on this court" | Card ghi "Idle". Thông báo đỏ phía trên bảng sân nói số trận chưa có giờ và dẫn sang Schedule. |
| Trận kế tiếp của sân, trận tiên quyết đang đánh | Card xanh "Ready", bấm Start được | Card chặn, ghi "Waiting for … to finish" |
| Mở trận trên trang Scores | Có nút Start | Không có nút Start; vẫn nhập và sửa kết quả được |
| Muốn dời trận sang sân khác | Dialog cho chọn sân và giờ | Không còn trên Desk; làm qua Schedule |
| Lệnh bắt đầu sai lọt tới server | Server chấp nhận | Server từ chối, kèm thông báo |

## 6. Kiểm thử

- **Unit test**:
  - `desk.ts`: trạng thái chặn khi trận tiên quyết đang đánh; không chặn khi trận tiên quyết đã reported, walkover hoặc void.
  - `deriveCourtState`: sân không có trận thì luôn ở trạng thái idle, không có trận để mở.
- **E2E (hermetic)**:
  - Sân trống không còn mở được trận.
  - Trang Scores không có Start.
  - Dialog trên Desk không còn phần dời sân và giờ.
  - Chạy lại các test về khả năng truy cập.
- **Integration test (Supabase local)**:
  - Bắt đầu trận chưa có giờ thì bị từ chối.
  - Bắt đầu với sân khác thì bị từ chối.
  - Bắt đầu đúng sân thì vẫn chạy như cũ, kể cả reflow sau đó.
- **Đủ các bước kiểm tra** theo AGENTS.md: typecheck, test, e2e, build, e2e:final, cộng integration test.
- **Một PR riêng cho Đợt 2.** Phần migration và RPC cần viết rõ trong PR: thay đổi này có thể làm hỏng gì, và đã kiểm tra những gì.

## 7. Cần bạn chốt

1. **Trang Scores:** bỏ hẳn nút Start (đề xuất), hay chỉ cho bắt đầu trận kế tiếp của sân?
2. **Trận tiên quyết chưa xong:** chặn (đề xuất) hay chỉ cảnh báo?
3. **Đồng ý với hệ quả của 3.1:** trận không xếp được thì không bắt đầu được từ Desk, phải xử lý qua Schedule.
