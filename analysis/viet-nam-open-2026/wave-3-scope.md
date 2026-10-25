# Đợt 3 — Gỡ trận kẹt, quyết định cuối ngày, giờ công bố tròn phút

*Bản đề xuất để duyệt. Chưa sửa code. Tiếp nối Đợt 1 (nhánh `fix/scheduler-silent-failures`), Đợt 2 (nhánh `feat/desk-start-guard`) và báo cáo [audit.md](audit.md).*

## 1. Mục tiêu

Sau Đợt 2, Desk chỉ bắt đầu đúng trận mà lịch đã xếp. Đợt 3 lo phần còn lại: **khi thực tế lệch khỏi lịch, hệ thống tự tìm cách sửa nhỏ nhất, rồi hỏi người vận hành một câu có/không**. Người vận hành không phải tự nghĩ ra cách sửa, và không phải chọn trận.

Ba việc:

1. **Gỡ trận kẹt** (mục 3.1). Khi trận kế tiếp của một sân bị chặn quá lâu, hệ thống đề xuất dời *riêng trận đó* sang chỗ trống gần nhất. Không rebuild, không đụng tới giờ của trận nào khác.
2. **Thẻ quyết định cuối ngày** (mục 3.2). Khi có trận không kịp xếp trước giờ đóng cửa hôm nay, hệ thống tính sẵn "nếu đánh thêm tới HH:MM thì xếp được hết", và hỏi có kéo dài không.
3. **Giờ công bố tròn phút** (mục 3.3). Không còn giờ kiểu 14:03:14, và bỏ những lần dời vài chục giây làm bảng nhảy số liên tục.

Bốn nguyên tắc của bạn áp dụng cho cả ba việc:

- **Giờ đã công bố là lời hứa.** Không bao giờ dời *sớm hơn* nếu không có người đồng ý. Dời *muộn hơn* thì phải báo cho VĐV.
- **Thuật toán quyết định, người vận hành chỉ duyệt.** Mỗi thẻ đưa ra đúng một phương án, đã tính sẵn, kèm cái giá của nó.
- **Một người vừa là organiser vừa là moderator.** Vì vậy thẻ quyết định được hiện ngay trên Desk (xem mục 3.4 về câu chữ trong AGENTS.md).
- **Xong sớm quan trọng hơn lấp kín mọi sân.**

**Không** nằm trong đợt này: thiết kế lại card, tự sắp xếp lại thứ tự trận trong một sân, cảnh báo khi bắt đầu sớm, các việc tối ưu thuật toán (mục 4).

## 2. Vì sao vẫn cần sau Đợt 1 và Đợt 2

| Vấn đề trong audit | Đợt 1–2 đã làm gì | Còn lại gì |
| --- | --- | --- |
| **A1. Sân 2 đứng yên 99 phút.** WD A r1 s1 bị chặn vì VĐV đang đánh ở sân khác, và không có gì tự gỡ. Chỉ khi bấm Rebuild lúc 14:02:59 mới hết. | Đợt 2 đóng nguyên nhân khởi phát: không còn bắt đầu được trận chưa có giờ (12:14 XD C r1 s1). | Một trận vẫn có thể bị kẹt theo cách khác: VĐV được gọi vào trận khác của họ ở sân khác (như lúc 13:53), hoặc một trận bắt đầu sớm (như 12:44 WS B r1 s1, người vận hành vẫn được quyền làm vậy). Reflow vẫn **không đụng tới trận đã quá giờ** (khoảng hổng 2 ở §3.5 của audit). Cách gỡ duy nhất vẫn là Rebuild. |
| **U5. Cách gỡ tự nhiên nhất là Rebuild, mà Rebuild kéo trận lên sớm.** | Không. | Phát lại lúc 12:40 ngày 2: rebuild đổi **10 trận, 6 trận bị kéo sớm 32–59 phút**. Điều này trái với nguyên tắc "giờ công bố là lời hứa". |
| **A4/A5/U6. Tràn ngày và câu hỏi "có nhét vào cuối ngày được không?"** | Đợt 1 thêm thông báo đỏ khi trận sẵn sàng không có giờ. | Ngày 1 (không phải ngày cuối), trận không kịp hôm nay bị **lặng lẽ xếp sang 12:01 hôm sau**: không có thông báo, không có câu hỏi. Người vận hành tự kéo XD r2-5 và XD mk2 về cuối ngày rồi tự hoàn tác (16:36, 16:55). Đổi giờ đóng cửa giữa giải thì được, nhưng phải rebuild, và phát lại cho thấy rebuild đổi **16 trận, 7 trận bị kéo sớm**. |
| **A7/U7. Giờ công bố tới từng giây, dời liên tục.** | Không. | 309 lần dời giờ, **186 lần dưới 1 phút**. 307/309 giờ mới mang số giây. |

Tóm lại: Đợt 1–2 làm cho lịch **không sai** nữa. Đợt 3 cho người vận hành một cách sửa lịch **khi nó lệch**, mà không phải rebuild.

## 3. Các thay đổi

### 3.1 Gỡ trận kẹt

#### Hiện tại

- Desk tính trạng thái sân bằng `deriveCourtState` (`src/lib/tournament/desk.ts:284`). Nó chỉ xem **trận sớm nhất** đang `scheduled` của sân. Nếu trận đó bị chặn, sân hiện *Waiting* kèm lý do, ví dụ "A. Nguyen, on Court 2". Lý do do `getMatchReadiness` tính (`desk.ts:208`), theo thứ tự: thiếu đội → VĐV đang ở sân khác (`player-busy`) → trận tiên quyết chưa xong (`waiting-prerequisite`, Đợt 2) → VĐV đang nghỉ (`resting`) → sẵn sàng.
- Desk không đếm sân đã bị chặn bao lâu, và không đề xuất gì.
- Reflow (`shift_live_schedule_core`, bản mới nhất ở `supabase/migrations/20261023000000_prerequisite_order.sql:236`) chỉ đưa vào hàng đợi những trận có giờ công bố **sau** trận vừa bắt đầu hoặc vừa xong (các lệnh `INSERT INTO live_schedule_queue`, dòng 538–585). Trận đã quá giờ đứng trước, nên không bao giờ được dời. Đó là lý do WD A đứng ở 12:25 (giờ công bố sau lần dời cuối) suốt 99 phút.
- Muốn dời một trận thì có hai đường, đều không hợp:
  - **Rebuild** (trang Schedule): giải lại mọi trận chưa đánh, nên kéo trận khác lên sớm.
  - **`reschedule_placement_match`** (`20260927000000_tournova_role_redesign.sql:2309`): dời một trận tới sân và giờ cho trước. Hàm này không kiểm tra thứ tự trận tiên quyết, giờ đóng cửa, hay "không sớm hơn giờ đã công bố". Đợt 2 đã gỡ nó khỏi Desk.
- `place_ready_matches` (`20261023000000_prerequisite_order.sql:32`) chỉ điền vào trận **chưa có** sân và giờ. Trận đã có giờ thì bị từ chối với lý do `already_placed` (dòng 123–125). Hiện **không có RPC nào xoá sân và giờ của một trận**.

#### Bằng chứng: chỉ thả đúng trận kẹt là đủ

Phát lại trạng thái lúc 12:40 ngày 2 (từ `tournament.json` và `desk-activity.csv`):

| Cách sửa | Số trận đổi giờ | Trận bị kéo sớm | Sân 2 |
| --- | ---: | ---: | --- |
| Rebuild toàn bộ | 10 | 6 (sớm 32–59 phút) | gỡ được |
| Thả riêng WD Draw A r1 s1 (xoá sân và giờ của nó), rồi chạy `planPlacementSchedule({ mode: "place-ready" })` | **1** | **0** | gỡ được: trận kế tiếp của sân 2 bắt đầu được |

Ở cách thứ hai, WD A r1 s1 được xếp sang **sân 5 lúc 13:55 (muộn hơn 90 phút)**. Không trận nào khác đổi giờ, vì chế độ `place-ready` coi mọi trận đã công bố là mốc cố định (`docs/scheduling-decisions.md` §27, "Held means held").

#### Thay đổi

**Khi nào hiện thẻ.** Desk hiện thẻ "Gỡ trận kẹt" cho một sân khi trận kế tiếp của sân **không bắt đầu được**, và thêm một trong hai điều kiện:

- (a) trận đó đã quá giờ công bố **≥ 15 phút**; hoặc
- (b) sân có **≥ 2 trận** đã quá giờ công bố.

"Không bắt đầu được" nghĩa là `getMatchReadiness` trả về:

- `player-busy`: một VĐV đang đánh ở sân khác; hoặc
- `waiting-prerequisite`: trận tiên quyết chưa xong.

**Khi nào không hiện thẻ:**

| Tình huống | Vì sao không hiện |
| --- | --- |
| Trận chỉ đang chờ VĐV nghỉ đủ (`resting`) | Vài phút nữa là đánh được. Card đã ghi "ready in N min". |
| VĐV vừa rảnh (trạng thái chuyển sang `ready`) | Việc đúng là bấm Start, không phải dời trận. Thẻ đang hiện thì tự biến mất. |
| Sân này đã được gỡ trong 10 phút vừa qua | Tránh dời liên tục khi trận chặn ở sân khác vẫn đang kéo dài. |
| Trận chưa đủ đội (`teams-missing`) | Không có VĐV thì không có gì để xếp. |
| Desk đang mất kết nối | Số liệu đã cũ, mọi thao tác ghi đều bị khoá (giống các nút khác). |

Với (b): nếu trận đầu hàng **bắt đầu được** thì không hiện thẻ, dù sân có nhiều trận quá giờ. Sân đó chỉ đang trễ, không bị kẹt.

**Thẻ tính sẵn phương án trước khi hỏi.** Desk chạy thử `planPlacementSchedule({ mode: "place-ready" })` trên dữ liệu đang có, với trận kẹt được coi như chưa có sân và giờ (chỉ trong bộ nhớ, không ghi gì). Kết quả chạy thử phải thoả cả bốn điều kiện, nếu không thì thẻ không đưa ra nút "Dời":

1. đúng **một** trận đổi chỗ, là trận kẹt;
2. giờ mới **muộn hơn** giờ cũ. Điều này luôn đúng: trận kẹt đã quá giờ, còn chế độ `place-ready` không xếp trận nào trước thời điểm hiện tại. Server vẫn kiểm tra lại (xem phần RPC bên dưới);
3. trận được thả không làm hỏng thứ tự với trận khác. Nếu chạy thử trả về `out_of_order` (trận kẹt là trận tiên quyết của một trận đã công bố, và chỗ mới lại nằm sau trận đó), thẻ không có nút "Dời" mà dẫn sang Schedule;
4. có chỗ trong hôm nay. Nếu chỉ có chỗ ở ngày mai, thẻ nói rõ "sang 12:01 ngày mai" và vẫn cho chọn. Nếu là ngày cuối và không còn chỗ, thẻ không có nút "Dời" mà dẫn sang thẻ cuối ngày (mục 3.2).

**Người vận hành thấy gì.** Thẻ nằm ở vùng thông báo phía trên bảng sân, cùng chỗ với thông báo đỏ của Đợt 1 (`desk.tsx:724`). Câu chữ gợi ý (giao diện bằng tiếng Anh):

> **Court 2 is stuck.** WD A R1 was due at 12:25 and can't start: Ly Van is playing on Court 6.
> Move it to **Court 5 at 13:55** (90 min later)? Court 2's next match can then go ahead. No other match changes. Its 4 players will be told.
> **[Move WD A R1]**  [Not now]

- **Move**: ghi ngay, rồi hiện toast "WD A R1 moved to Court 5 at 13:55. Players told."
- **Not now**: ẩn thẻ của sân này 10 phút.
- Có nhiều sân kẹt cùng lúc thì mỗi sân một thẻ, sân bị kẹt lâu nhất đứng trước. Hiện tối đa 2 thẻ, còn lại ghi "and N more".
- Chỉ người có quyền sửa giải (`canEdit`) mới thấy thẻ, giống thông báo đỏ hiện nay.

**Thứ tự ưu tiên trong vùng thông báo:** thanh mất kết nối → thẻ quyết định (mục này và mục 3.2) → thông báo đỏ "N ready matches have no time yet".

**Thời gian chờ 10 phút được lưu ở đâu.** Nếu chỉ lưu trong trình duyệt thì sẽ mất khi tải lại trang, và hai máy Desk sẽ thấy khác nhau. Đề xuất: RPC gỡ trận ghi một dòng `desk_activity` (hành động mới `released`). Desk đọc lần gỡ gần nhất của sân từ đó. Riêng "Not now" là lựa chọn của một người, nên chỉ lưu trong trình duyệt.

#### Server: một RPC mới, ghi trong một giao dịch

**Đề xuất:** thêm RPC `release_and_place_matches`. Không dùng lại `place_ready_matches` theo kiểu "xoá trước, xếp sau" từ phía trình duyệt, vì ba lý do:

1. Hiện không có RPC nào xoá sân và giờ của một trận. Dù chọn cách nào cũng phải có migration.
2. Nếu xoá và xếp là hai lệnh riêng, sẽ có lúc trận **không có giờ**. Lúc đó bảng công khai và thông báo đỏ của Desk khác sẽ nhấp nháy, và nếu lệnh xếp thất bại (VĐV vừa được gọi vào trận khác) thì trận bị bỏ lơ cho tới khi reconciler thử lại.
3. "Chỉ dời muộn hơn" phải là **lời hứa của server**, không phải chuyện tình cờ đúng ở phía giao diện.

RPC làm những việc sau, tất cả trong một giao dịch:

| Bước | Nội dung |
| --- | --- |
| 1 | Kiểm tra quyền (`can_edit_tournament`), giải đang diễn ra, và lấy cùng khoá `live-schedule` như mọi writer khác. |
| 2 | Với mỗi trận được thả: còn `scheduled` và còn **đúng sân và giờ mà trình duyệt đã thấy**. Nếu khác (vừa có reflow, vừa có người bắt đầu trận) thì từ chối là `stale`, không đổi gì. |
| 3 | Xoá sân và giờ của các trận đó. |
| 4 | Gọi `place_ready_matches` (cùng giao dịch) cho các vị trí mới. Như vậy mọi kiểm tra hiện có được dùng lại nguyên vẹn: sân bận, VĐV bận hoặc chưa nghỉ đủ, thứ tự trận tiên quyết, không xếp vào quá khứ. |
| 5 | Nếu `place_ready_matches` bỏ qua dù chỉ một vị trí → huỷ cả giao dịch, trả về lý do. Không bao giờ để trận bị thả mà không có giờ. |
| 6 | Kiểm tra hướng dời. Mặc định giờ mới phải **≥ giờ cũ**. Chỉ khi có tham số đồng ý tường minh (dùng cho mục 3.2) mới cho phép sớm hơn. |
| 7 | Ghi `desk_activity` (trigger hiện có tự ghi `time-shifted` / `court-moved`; thêm một dòng `released` kèm lý do) và gửi thông báo cho VĐV (xem "Báo cho VĐV" bên dưới). |

Trận kẹt có thể là trận knockout (`tier_draw_matches`, như WD Draw A) hoặc trận placement. RPC nhận cả hai loại.

#### Báo cho VĐV

**Hiện tại không có thông báo tự động nào khi giờ thay đổi.** VĐV chỉ thấy giờ mới trên bảng công khai. Hộp thư trong ứng dụng (`player_notifications`, `20261024000000_in_app_call_next.sql`) chỉ nhận lời gọi "Call next" do người vận hành bấm tay, và mỗi dòng phải gắn với một `match_calls`.

Đề xuất cho Đợt 3: khi RPC ở trên dời một trận, nó ghi luôn một mục vào hộp thư của các VĐV có tài khoản liên kết, ví dụ "Your match WD A R1 moved to Court 5 at 13:55 (was 12:25)." Cần một migration nhỏ: thêm cột `kind` (`call` | `schedule-change`) cho `match_calls`, để Desk không hiểu nhầm đây là một lần "Call next". VĐV không có tài khoản liên kết thì thẻ nói rõ "2 players have no linked account: tell them at the desk."

Chỉ những lần dời do **thẻ quyết định** gây ra mới gửi thông báo. Các lần reflow dời giờ thông thường vẫn như hiện nay (chỉ đổi trên bảng). Xem câu hỏi 4.

#### Hệ quả cần chấp nhận

- Trận kẹt có thể bị dời **rất xa** (+90 phút ở ví dụ trên) và **sang sân khác**. Đó là cái giá để không trận nào khác phải đổi.
- Nếu trận chặn ở sân khác kết thúc ngay sau khi gỡ, trận vừa dời vẫn giữ giờ mới (không kéo sớm lại). Ngưỡng 15 phút là để giảm khả năng này.
- Sau khi gỡ, trận kế tiếp của sân kẹt **không bị kéo sớm**. Nó vẫn giữ giờ đã công bố. Người vận hành có thể bắt đầu sớm nếu muốn, như hiện nay.
- Trận vừa dời có thể bị kẹt lại lần nữa. Khi đó, sau 10 phút, thẻ có thể hiện lại.

#### Phạm vi sửa

- `src/lib/tournament/stuck-court.ts` (mới): hàm thuần `findStuckCourts(courtStates, now, lastReleaseByCourt)` trả về các sân kẹt và lý do; hàm `planRelease(...)` chạy thử `place-ready` với trận được thả và kiểm tra bốn điều kiện.
- `desk.tsx`: vùng thông báo, thẻ, gọi RPC, toast. Desk đã có đủ dữ liệu cho bộ lập lịch, vì `useAutoScheduleExecutor` (`src/hooks/useAutoSchedule.ts`) dùng cùng nguồn. Nên tách phần dựng đầu vào bộ lập lịch ra để dùng chung, thay vì chép lại.
- `src/lib/tournament/placement-actions.ts`: hàm gọi RPC.
- Migration mới: `release_and_place_matches`, hành động `released` trong `desk_activity`, cột `kind` cho `match_calls`.
- Tài liệu: `docs/scheduling-decisions.md` §33 (mới), `docs/desk-notifications.md` (thẻ quyết định), AGENTS.md (mục 3.4).

#### Kiểm thử

- **Unit** `stuck-court.test.ts`: kích hoạt ở 15 phút chứ không phải 14; kích hoạt khi sân có 2 trận quá giờ; không kích hoạt khi `resting`, khi `ready`, khi vừa gỡ dưới 10 phút; trận đầu hàng bắt đầu được thì không kích hoạt.
- **Phát lại** (`viet-nam-open-replay.test.ts`): thêm ảnh chụp **12:40 ngày 2** vào fixture ngày 2. Kiểm tra: thẻ hiện cho sân 2; phương án là WD Draw A r1 s1 → sân 5, 13:55; đúng 1 trận đổi; không trận nào sớm hơn.
- **E2E (hermetic)**: Desk hiện thẻ, bấm Move gọi RPC với đúng tham số; Not now ẩn thẻ; người không có quyền sửa không thấy thẻ; kiểm tra khả năng truy cập của thẻ (nút có tên rõ, thẻ là `role="status"`).
- **Integration (Supabase local)**: dời thành công; từ chối `stale` khi giờ đã đổi; từ chối khi giờ mới sớm hơn mà không có tham số đồng ý; huỷ cả giao dịch khi vị trí mới bị chiếm; người không có quyền bị từ chối; VĐV có tài khoản nhận được mục trong hộp thư.

### 3.2 Thẻ quyết định cuối ngày

#### Hiện tại — hai trường hợp khác nhau

Bộ lập lịch xếp từng ngày, ngày 1 trước, phần không vừa thì tràn sang ngày sau (`runPlanDays`, `src/lib/tournament/scheduling/day-plan.ts:507–510`):

```ts
const hardEnd = day.id === lastFilledDayId && !strictClose ? undefined : planningEnd;
```

Nghĩa là:

| Ngày | Chế độ tự xếp (`place-ready`, có `strictClose`) làm gì với trận không kịp hôm nay | Người vận hành thấy gì |
| --- | --- | --- |
| **Không phải ngày cuối** | Tự xếp sang ngày sau, **và ghi luôn giờ đó**. Không có lý do `past_closing`. | Không có gì. Trận chỉ biến mất khỏi hôm nay. |
| **Ngày cuối** | Để trống, lý do `past_closing` (`classifyUnplaced`, `src/lib/tournament/placement-schedule.ts:1118`). | Thông báo đỏ: "They would finish after the last day closes. Extend a day, add a court, or review a rebuild." (`describeUnplaced`, `src/lib/tournament/auto-schedule.ts:244`). |

Lưu ý: yêu cầu ban đầu nói "khi không xếp được trước giờ đóng cửa hôm nay (`past_closing`)". Theo code, `past_closing` **chỉ xảy ra ở ngày cuối**. Ở các ngày khác, tín hiệu đúng là "lần tự xếp vừa đặt trận sẵn sàng của hôm nay sang một ngày sau". Đề xuất dùng cả hai tín hiệu.

Ở Viet Nam Open, lúc 15:53:07 và 16:03:33 ngày 1, lần tự xếp **đã công bố** 5 trận ở 12:01 ngày 2 (audit A4). Ai xem bảng lúc đó đều thấy "12:01 ngày mai".

Giờ đóng cửa sửa được giữa giải (`commitDayWindow`, `src/components/schedule/placement-scheduler.tsx:1303`, gọi `updateTournamentDay` ở `src/lib/tournament/actions.ts:813`). Nhưng sửa xong thì không có gì tự xếp lại. Muốn trận về lại hôm nay phải rebuild, và rebuild kéo trận khác lên sớm.

#### Bằng chứng

Phát lại lúc 16:04 ngày 1 (giờ đóng cửa 17:00), thả riêng 5 trận bị tràn (XD r2-5, XD r2-makeup-2, MS r2-1, MS r2-4, MS r2-makeup-2) rồi chạy `place-ready`:

| Giờ đóng cửa thử | Kết quả | Trận khác đổi giờ |
| --- | --- | ---: |
| 17:00 (như cũ) | Cả 5 vẫn ở ngày 2 | 0 |
| **17:30** | **Cả 5 xếp được trong ngày 1, trận cuối xong lúc 17:21** | **0** |
| 17:30 + rebuild toàn bộ (cách hiện có) | Xếp được, nhưng đổi 16 trận | 16 (7 trận sớm hơn) |

Gia hạn 30 phút và chỉ thả đúng những trận bị tràn là đủ.

#### Thay đổi

**Thiết lập mới cho mỗi ngày: "Gia hạn tối đa"** (max extension), mặc định 30 phút, sửa ở trang Schedule cạnh giờ mở và đóng cửa. Đặt 0 nghĩa là không bao giờ đề nghị gia hạn ngày đó. Giới hạn được tính từ **giờ đóng cửa ban đầu**, nên gia hạn hai lần trong một ngày không vượt quá mức này. Vì vậy cần lưu cả giờ đóng ban đầu, không chỉ giờ đóng hiện tại. Cần migration cho `tournament_days`: thêm `max_extension_minutes` và `planned_end_time`, trong đó `planned_end_time` được ghi ở lần gia hạn đầu tiên.

**Khi nào hiện thẻ:**

- Ngày đang xem không phải ngày cuối, và có trận **bị tự xếp đẩy từ hôm nay sang ngày sau** (xem "Dấu vết trận bị tràn" bên dưới), **trong khi hôm nay vẫn chưa qua giờ đóng cửa**; hoặc
- Ngày đang xem là ngày cuối, và có trận sẵn sàng bị để trống với lý do `past_closing`.

**Dấu vết trận bị tràn — phải lưu trên server.** Desk cần biết trận nào ở ngày mai là do lần tự xếp hôm nay *đẩy sang*, và trận nào vốn được lần build đầu tiên chủ ý đặt ở ngày mai. Nhìn lịch thì không phân biệt được: cả hai đều là "trận sẵn sàng có giờ ở ngày sau". Nếu nhầm, thẻ sẽ đề nghị kéo cả những trận vốn thuộc ngày mai về tối nay, tức là dời sớm một giờ đã hứa, và câu "won't fit before 17:00" sẽ sai. Kết quả của lần tự xếp chỉ nằm trong trình duyệt đã chạy nó, mất khi tải lại trang và máy Desk thứ hai không thấy. `desk_activity` hiện cũng không ghi ai là người ghi (dòng `court-moved` chỉ có giờ và sân mới).

Đề xuất: thêm cột `deferred_from_day_id` cho `placement_matches` và `tier_draw_matches`. `place_ready_matches` ghi cột này khi nó đặt một trận vào một ngày **sau** ngày đang diễn ra, và ngày đang diễn ra chưa đóng cửa. Lần build đầu và rebuild đi qua `apply_placement_day_schedule`, không ghi cột này, và rebuild xoá nó (rebuild là một kế hoạch có chủ ý). Cột cũng bị xoá khi trận được kéo về hoặc bắt đầu. Thẻ chỉ dùng những trận có `deferred_from_day_id` bằng hôm nay.

**Hệ thống tính sẵn.** Desk chạy thử `place-ready`. Các trận bị tràn được coi như chưa có giờ, giờ đóng hôm nay được nới dần **mỗi lần 5 phút**, tới tối đa giờ đóng ban đầu + "Gia hạn tối đa". Desk dừng ở mức nới **nhỏ nhất** mà:

- **mọi** trận bị tràn đều xếp được trong hôm nay; và
- **không trận nào khác** đổi giờ. Điều này đúng sẵn ở chế độ `place-ready`, nhưng vẫn kiểm tra bằng bảng so sánh của lần chạy thử.

Xếp được một phần (ví dụ 3/5) thì không tính. Gia hạn chỉ để chơi được 3 trận, rồi vẫn phải chia vòng sang ngày mai, là cái giá không đáng.

**Người vận hành thấy gì.**

Có mức gia hạn phù hợp, ngày không phải ngày cuối:

> **5 matches won't fit before 17:00.** They are now scheduled tomorrow at 12:01.
> Play until **17:30** instead? All 5 would finish today by 17:21. No other match changes. Their players will be told, so check they can stay.
> **[Play until 17:30]**  [Keep them tomorrow]

Không có mức gia hạn nào đủ:

> **5 matches move to tomorrow.** Playing them today would need more than 30 extra minutes. They start at 12:01 tomorrow.
> [OK]

Ngày cuối:

> **3 matches won't fit before 18:30**, the last day's close.
> Play until **18:50**? All 3 would finish by 18:47. No other match changes.
> **[Play until 18:50]**  [Leave them unplaced]

Ngày cuối không có mức gia hạn nào đủ: thẻ chỉ báo, và giữ link "Review the schedule" như thông báo đỏ hiện nay (lựa chọn còn lại là sửa ở Schedule: thêm sân, đổi cài đặt, rebuild).

"Leave them unplaced" để trận không có giờ. Thông báo đỏ của Đợt 1 vẫn nhắc về chúng.

**Khi bấm "Play until HH:MM".** Một RPC (cùng `release_and_place_matches`, thêm tham số gia hạn ngày) làm trong một giao dịch: đổi giờ đóng của ngày (ghi `planned_end_time` nếu là lần đầu), kiểm tra giờ mới không vượt giới hạn, thả các trận bị tràn, xếp lại chúng. Nếu một vị trí bị từ chối thì huỷ tất cả, **kể cả việc gia hạn**: không bao giờ để ngày bị gia hạn mà trận vẫn ở ngày mai.

#### Mâu thuẫn với "giờ công bố là lời hứa", cần bạn chọn

Ở ngày không phải ngày cuối, 5 trận kia **đã được công bố** ở 12:01 ngày mai. Đưa chúng về 17:xx hôm nay là **dời sớm hơn** gần 19 tiếng. Có hai cách thiết kế:

| | (A) Để trận tràn sang ngày mai như hiện nay, thẻ đề nghị kéo về | (B) Giữ lại, chưa công bố, hỏi trước |
| --- | --- | --- |
| Lần tự xếp | Không đổi: ghi giờ ngày mai ngay | Không ghi những trận sẽ tràn, **nếu** gia hạn trong giới hạn có thể chứa chúng. Chúng tạm không có giờ. |
| Thẻ | "Play until 17:30" / "Keep them tomorrow" | "Play until 17:30" / "Move to tomorrow" |
| Đồng ý dời sớm | Chính cú bấm của người vận hành là sự đồng ý. Thẻ nhắc hỏi VĐV trước. VĐV được báo. | Không có lần dời sớm nào, vì chưa có giờ công bố. |
| Nếu không ai trả lời | Trận vẫn có giờ ngày mai: an toàn. | Trận không có giờ. Phải có quy tắc, ví dụ tới giờ đóng cửa thì tự xếp sang ngày mai, nhưng quy tắc này chỉ chạy khi có Desk hoặc trang Schedule đang mở. |
| Độ phức tạp | Thấp | Cao hơn: lần tự xếp phải biết về gia hạn, và cần cơ chế hết hạn |
| Rủi ro | VĐV thấy "12:01 ngày mai" rồi về, sau đó giờ đổi thành tối nay | Trận lơ lửng không có giờ nếu Desk bị đóng |

**Đề xuất: (A).** Nó không bao giờ để trận không có giờ, khớp với thiết kế đã thống nhất ("chỉ thả những trận bị tràn"), và đơn giản hơn nhiều. Thẻ hiện ngay khi trận bị tràn (thường vài giây sau kết quả mở vòng), nên khoảng thời gian VĐV kịp thấy giờ ngày mai là ngắn. Để giảm rủi ro, thẻ ghi rõ "check they can stay", và VĐV có tài khoản được báo ngay.

#### Hệ quả cần chấp nhận

- Ngày được gia hạn thật sự, mọi chỗ khác đều thấy: thanh ngày trên Desk, trang Schedule, `schedule_conflicts` (`past_closing` dùng giờ đóng mới), và reflow (trận bị giữ vì vượt giờ đóng cũ có thể được dời trong lần reflow sau, nhưng chỉ dời muộn hơn).
- Gia hạn không tự hoàn tác. Nếu trận xong sớm, ngày vẫn ghi giờ đóng mới. Không ảnh hưởng gì khác ngoài con số trên màn hình.
- Không gia hạn thì hành vi giữ nguyên như hiện nay, chỉ thêm thẻ báo.

#### Phạm vi sửa

- `src/lib/tournament/day-extension.ts` (mới): hàm thuần `planDayExtension(...)` chạy thử theo bước 5 phút và trả về mức nhỏ nhất, hoặc "không có".
- `src/lib/tournament/data.ts` và mô hình trận của Desk: đọc `deferred_from_day_id`.
- `desk.tsx`: thẻ, nút, toast.
- `placement-scheduler.tsx`: ô "Max extension" cạnh giờ đóng cửa của mỗi ngày; hiển thị "extended from 17:00" khi ngày đã được gia hạn.
- Migration: hai cột mới cho `tournament_days`; cột `deferred_from_day_id` và thân mới của `place_ready_matches` (ghi cột) và `apply_placement_day_schedule` (xoá cột); tham số gia hạn cho RPC ở mục 3.1.
- Tài liệu: `scheduling-decisions.md` (§28 "Automatic placement never runs past the close" cần thêm một câu về thẻ cuối ngày), `desk-notifications.md`.

#### Kiểm thử

- **Unit** `day-extension.test.ts`: chọn mức nhỏ nhất; không vượt giới hạn; xếp được một phần thì trả về "không có"; ngày cuối và ngày thường.
- **Phát lại**: fixture **mới cho ngày 1** (ảnh chụp 16:04; fixture hiện có chỉ là ngày 2) dựng lại từ `desk-activity.csv`. Kiểm tra: đề nghị mức nhỏ nhất xếp được cả 5 (17:30 đã kiểm chứng; 17:25 chưa chạy thử); cả 5 trận xong muộn nhất 17:21; 0 trận khác đổi; với giới hạn 0 thì thẻ chỉ báo "move to tomorrow".
- **E2E**: thẻ hiện với hai nút, và bản chỉ báo; ô "Max extension" lưu được.
- **Integration**: gia hạn và xếp lại trong một giao dịch; vượt giới hạn bị từ chối; vị trí bị chiếm thì huỷ cả việc gia hạn.

### 3.3 Giờ công bố tròn phút, và chỉ ghi khi dời ≥ 2 phút

#### Hiện tại

- Reflow tính giờ mới tới micro-giây. Bất cứ khi nào giờ mới khác giờ cũ dù chỉ một chút, nó đều ghi: `IF next_start IS DISTINCT FROM current_match.shifted_time THEN` (`20261023000000_prerequisite_order.sql:828`).
- Trigger `20261023010000_whole_millisecond_match_times.sql` cắt giờ về **mili-giây** (cắt bớt, không làm tròn lên). Không có gì làm tròn về phút.
- Bộ lập lịch phía trình duyệt cũng tạo giờ có số giây: trận được đặt ngay sau `ended_at` + thời gian nghỉ, hoặc sau giờ kết thúc dự kiến của trận đang đánh. Trong `desk-activity.csv`, 53/115 dòng `court-moved` (chủ yếu từ tự xếp và rebuild) mang số giây.
- `schedule_conflicts` (`20261018000000_conflict_overrun_alignment.sql:46`) so sánh chặt: chồng sân (`a.eff_start < b.eff_court_end`, dòng 243), nghỉ thiếu (`r.eff_start < r.prev_end + r.rest_gap`, dòng 272), trước trận tiên quyết (`e.eff_start < pre.eff_end`, dòng 309).

#### Hai lựa chọn, với số liệu Viet Nam Open

Đếm lại trên 309 dòng `time-shifted`, theo từng trận (mỗi trận nhớ giờ đang công bố của nó). Đây là **ước lượng**: phép đếm phát lại đúng chuỗi dời đã xảy ra, trong khi một lần không ghi sẽ làm các lần reflow sau bắt đầu từ con số khác, nên số thật sẽ hơi khác:

| Cách | Số lần ghi (ước lượng) | Giảm | Giờ công bố so với giờ thật của mô hình | `schedule_conflicts` |
| --- | ---: | ---: | --- | --- |
| Hiện tại | 309 | — | Đúng tới mili-giây | Không đổi |
| **(1) Chỉ làm tròn lên phút** | 196 | −37% | Muộn hơn tối đa 59 giây (không bao giờ sớm hơn) | **Không cần đổi** |
| **(2) Làm tròn lên phút + chỉ ghi khi dời ≥ 2 phút** | 123 | −60% | Có thể **sớm hơn** mô hình tới dưới 2 phút (trên dữ liệu này tối đa 60 giây) | **Phải thêm dung sai 2 phút** |

Vì sao phải **làm tròn lên** chứ không làm tròn gần nhất: làm tròn 14:03:14 xuống 14:03 sẽ xếp trận bắt đầu trước khi sân trống hoặc trước khi VĐV nghỉ đủ, và `schedule_conflicts` sẽ báo lỗi ngay cho trận vừa xếp. Làm tròn lên thì không bao giờ phá ràng buộc.

Vì sao **không** làm trong trigger mili-giây: trigger đó chạy cho mọi lần ghi, kể cả `started_at` và `ended_at` (là giờ thật, không được làm tròn), và nó cắt bớt (dời sớm). Làm tròn phải do từng writer làm, trước khi kiểm tra ràng buộc.

#### Thay đổi (đề xuất (2), đúng như đã thống nhất)

**Làm tròn lên phút ở mọi chỗ ghi giờ công bố:**

- Reflow (`shift_live_schedule_core`, migration mới): làm tròn `next_start` lên phút **ngay trong vòng lặp**, trước khi so sánh và lan sang trận sau. Như vậy các trận phía sau được tính từ đúng con số sẽ công bố.
- Bộ lập lịch (`planPlacementSchedule`, cả rebuild và `place-ready`): làm tròn lên phút các mốc "rảnh từ lúc nào" (giờ kết thúc + nghỉ, giờ kết thúc dự kiến của trận đang đánh). Vì thời lượng slot và thời gian nghỉ đều là số phút nguyên, cả lịch sẽ thẳng hàng theo phút.
- RPC mới ở mục 3.1 nhận giờ đã làm tròn từ bộ lập lịch.
- Thêm một kiểm tra trong `db-invariants.test.ts` rằng các writer trên làm tròn lên.

**Chỉ ghi khi dời ≥ 2 phút** (chỉ áp dụng trong reflow):

- Nếu giờ mới (đã làm tròn) chênh với giờ đang công bố **dưới 2 phút**, reflow không ghi trận đó, và trận giữ giờ cũ.
- Phần tính toán bên trong vẫn dùng giờ chính xác, nên các trận phía sau vẫn được tính đúng.
- Độ lệch không cộng dồn: mỗi lần reflow đều so với giờ đang lưu, nên khi tổng độ lệch đạt 2 phút thì trận được ghi.

**`schedule_conflicts` dùng cùng ngưỡng.** Một trận giữ giờ cũ có thể bắt đầu sớm hơn giờ kết thúc *thật* của trận trước tới dưới 2 phút. Nếu không có dung sai, trận đó sẽ bị báo `court_overlap` hoặc `rest_shortfall` ngay, mà thật ra không có gì sai.

- Dung sai **chỉ áp dụng khi một bên là giờ thật** (trận đang đánh hoặc đã xong: `started_at`, `ended_at`, giờ kết thúc dự kiến của trận quá giờ).
- Hai trận **đều là giờ công bố** thì vẫn so chặt như cũ. Một chồng chéo giữa hai giờ công bố, dù chỉ 1 phút, vẫn là lỗi thật và vẫn bị báo.
- Ngưỡng đặt ở **một chỗ** (một hàm SQL trả về `interval '2 minutes'`) để reflow và `schedule_conflicts` không thể lệch nhau.

**Thông báo cho VĐV.** Hiện chưa có thông báo tự động khi reflow dời giờ (xem mục 3.1). Ngưỡng 2 phút áp dụng cho việc ghi giờ, nên tự động áp dụng cho bảng công khai, nhật ký, và mọi thông báo tự động sau này.

#### Hệ quả cần chấp nhận

- Giờ trên bảng có thể sớm hơn thực tế tới dưới 2 phút. VĐV tới đúng giờ có thể phải chờ thêm tối đa 1–2 phút. Hiện nay họ cũng chờ như vậy, vì Desk bắt đầu trận theo người chứ không theo đồng hồ.
- Desk tính "quá giờ" theo giờ công bố. Một trận có thể bị coi là quá giờ sớm hơn thực tế tới dưới 2 phút. Ngưỡng 15 phút của mục 3.1 không bị ảnh hưởng đáng kể.
- Dữ liệu cũ (giờ có số giây) giữ nguyên. Đề xuất **không** chạy migration sửa lại dữ liệu cũ, vì một giải đang diễn ra sẽ thấy giờ đổi mà không có lý do. Xem câu hỏi 6.
- Trang giới thiệu: phần demo xếp lịch (`src/components/landing/schedule-demo-data.ts`) đã dùng phút nguyên. Cần kiểm tra lại xem demo reflow có hiện những lần dời dưới 2 phút không. Nếu có thì sửa theo, vì AGENTS.md yêu cầu trang giới thiệu không hứa điều app không làm (`schedule-demo-data.test.ts`).

#### Phạm vi sửa

- Migration mới: thân mới của `shift_live_schedule_core` (làm tròn lên + ngưỡng) và `schedule_conflicts` (dung sai khi một bên là giờ thật), cùng một hàm ngưỡng dùng chung. Không sửa migration đã áp dụng.
- `src/lib/tournament/placement-schedule.ts`, `src/lib/tournament/scheduling/day-plan.ts`, `src/lib/tournament/in-progress.ts`: làm tròn lên các mốc "rảnh từ lúc nào".
- `src/lib/tournament/db-invariants.test.ts`: thêm kiểm tra thân hàm.
- Tài liệu: `scheduling-decisions.md` §31.1 (bổ sung "giờ công bố là phút nguyên") và §29 (`inProgressEnd`).

#### Kiểm thử

- **Unit**: bộ lập lịch không bao giờ trả về giờ có số giây; làm tròn lên chứ không xuống; các test hiện có của `placement-schedule.test.ts` và replay vẫn qua (một số kỳ vọng giờ sẽ phải đổi sang phút nguyên. Mỗi chỗ đổi phải đúng là làm tròn lên của giá trị cũ).
- **Integration** (`integration/live-reflow.test.ts`): dời 40 giây thì không ghi; dời 2 phút 10 giây thì ghi và ra phút nguyên; ba lần dời 50 giây liên tiếp thì ghi ở lần thứ ba; `schedule_conflicts` không báo cho trận giữ giờ cũ lệch 90 giây so với giờ kết thúc thật, nhưng vẫn báo hai giờ công bố chồng nhau 1 phút.
- Chạy lại các test hiện có về reflow (`live-reflow`, `start-match-checks`, `placement-feeders`), vì đây là vùng rủi ro cao.

### 3.4 Câu chữ trong AGENTS.md

AGENTS.md hiện viết: *"Keep the two operators apart. A moderator should not be shown tournament-wide forecasts, and an organiser should not be shown desk-level operational noise."* Thẻ quyết định trên Desk thay đổi một phần lịch (dời một trận, gia hạn ngày), là việc của organiser. Bạn đã đồng ý đặt thẻ trên Desk, vì trên thực tế một người làm cả hai vai. Đề xuất thêm vào AGENTS.md, ngay sau câu trên:

> In practice one person often does both jobs, so the Desk may carry a **decision card** when a schedule decision cannot wait for the Schedule tab: a court that is stuck behind a blocked match, or ready matches that will not fit before today's close. A decision card is about today only, offers exactly one change the scheduler has already worked out, states its cost, never moves another match's published time, never moves a published time earlier without the operator saying so, and is shown only to people who may edit the tournament. Forecasts and whole-tournament planning stay on the Schedule tab.

## 4. Không làm trong đợt này

| Mục | Lý do |
| --- | --- |
| Thiết kế lại card sân | Đã thống nhất để sau. Đợt 3 chỉ thêm thẻ vào vùng thông báo đã có. |
| Tự sắp xếp lại thứ tự trận trong một sân (cho trận sau lên trước khi trận đầu bị chặn) | Đã thống nhất để sau. Gỡ trận kẹt đạt cùng mục đích mà không đổi giờ trận nào khác. |
| Cảnh báo khi bắt đầu sớm | Đã quyết định: người vận hành được tự quyết. |
| Tối ưu: phân tán sân (P1-5), khép giai đoạn chậm nhất trước (P2-12), ước lượng công suất theo ngày (P1-8) | Việc tối ưu, để sau. |
| Thông báo VĐV cho mọi lần reflow dời giờ | Chỉ thông báo cho lần dời do thẻ quyết định gây ra (câu hỏi 4). |
| Tự gỡ trận kẹt mà không hỏi | Trái nguyên tắc "người vận hành duyệt". Có thể cân nhắc sau khi có dữ liệu giải thật. |
| Sửa dữ liệu cũ về phút nguyên | Câu hỏi 6. |
| Đưa `reassign_court_matches` (sân hỏng) lên giao diện | Việc riêng, như ở Đợt 2. |

## 5. Người vận hành sẽ thấy gì khác

| Tình huống | Trước | Sau |
| --- | --- | --- |
| Trận kế tiếp của sân bị chặn (VĐV ở sân khác) đã 15 phút | Sân ghi "Waiting", không có gì khác. Muốn gỡ phải rebuild ở Schedule, và rebuild kéo trận khác lên sớm. | Thẻ "Court 2 is stuck": dời riêng trận đó tới chỗ trống gần nhất, nói rõ sân và giờ mới, không trận nào khác đổi. Một chạm. |
| Trận chỉ đang chờ VĐV nghỉ | "ready in N min" | Như cũ, không có thẻ |
| Trận không kịp trước giờ đóng (ngày thường) | Lặng lẽ sang 12:01 hôm sau | Thẻ: "Play until 17:30?" nếu gia hạn trong giới hạn xếp được hết; nếu không thì báo "move to tomorrow" |
| Trận không kịp trước giờ đóng (ngày cuối) | Thông báo đỏ, phải tự sửa ở Schedule | Thẻ: "Play until HH:MM?" hoặc "Leave them unplaced" |
| Giờ trên bảng | 14:03:14, nhảy vài chục giây sau mỗi kết quả | 14:04, chỉ đổi khi lệch từ 2 phút |
| Thiết lập ngày | Giờ mở, giờ đóng, sân, nghỉ | Thêm "Max extension" (mặc định 30 phút) |
| VĐV có trận bị thẻ dời | Không ai báo | Nhận mục trong hộp thư ứng dụng (nếu có tài khoản liên kết); thẻ nhắc báo trực tiếp người không có tài khoản |

## 6. Kế hoạch kiểm thử

Cả ba mục đều chạm vùng rủi ro cao (lập lịch, RPC, database), nên **mọi giai đoạn** đều chạy đủ các bước theo AGENTS.md, không để "e2e chạy sau":

```
npm run typecheck
npm run test
npm run test:e2e
npm run test:e2e:final
npm run build
```

Cộng thêm, vì có migration và RPC mới:

```
npx supabase start
npm run integration:target -- local
npm run test:integration
npm run integration:target -- use staging
```

- **Unit và phát lại**: như mục 3.1–3.3. Fixture mới ngày 1 (16:04) và ảnh chụp mới ngày 2 (12:40), dựng lại từ `tournament.json` và `desk-activity.csv` bằng cùng cách với fixture hiện có.
- **E2E (hermetic)**: thẻ gỡ trận kẹt, thẻ cuối ngày (ba dạng), ô "Max extension". Chạy lại các spec về khả năng truy cập (`a11y`, `criteria`, `route-sweep`, `states`). Nếu thêm file spec mới thì chạy `npm run ci:shard-plan`.
- **Integration (Supabase local)**: RPC `release_and_place_matches` (thành công, `stale`, không cho sớm hơn, huỷ cả giao dịch, quyền), gia hạn ngày, thông báo VĐV, reflow làm tròn và ngưỡng 2 phút, `schedule_conflicts` với dung sai.
- **Đề xuất ba PR riêng, theo thứ tự**: 3.3 trước (đổi reflow và giờ, nền cho hai mục kia), rồi 3.1, rồi 3.2 (dùng lại RPC của 3.1). Mỗi PR có migration và RPC phải viết rõ trong mô tả: thay đổi có thể làm hỏng gì, và đã kiểm tra những gì.

## 7. Cần bạn chốt

1. **Ngưỡng kích hoạt gỡ trận kẹt:** quá giờ ≥ 15 phút *hoặc* sân có ≥ 2 trận quá giờ, và trong cả hai trường hợp trận đầu hàng phải đang bị chặn (VĐV ở sân khác hoặc trận tiên quyết chưa xong). Đồng ý cách hiểu "trận đầu hàng bắt đầu được thì không hiện thẻ, dù có 2 trận quá giờ"?
2. **Thời gian chờ 10 phút** tính theo **sân** (đề xuất) hay theo trận? Và lưu trên server qua `desk_activity` (đề xuất, hai máy Desk thấy giống nhau) hay chỉ trong trình duyệt?
3. **Cuối ngày, ngày thường: (A) hay (B)?** Đề xuất (A): trận vẫn tự tràn sang ngày mai như hiện nay, thẻ đề nghị kéo về tối nay, và cú bấm của người vận hành là sự đồng ý dời sớm. (B) là giữ lại chưa công bố cho tới khi có người quyết. Với (A), server phải đánh dấu trận nào bị tràn (cột `deferred_from_day_id`), để thẻ không bao giờ kéo về những trận vốn được xếp cho ngày mai.
4. **Báo cho VĐV:** đồng ý thêm mục "lịch thay đổi" vào hộp thư ứng dụng hiện có (thêm cột `kind` cho `match_calls`), và chỉ gửi cho những lần dời do thẻ quyết định gây ra? Hay muốn gửi cho mọi lần dời giờ ≥ 2 phút? (Gửi cho mọi lần thì ở Viet Nam Open sẽ là khoảng 123 lần dời (ước lượng), nhân với số VĐV.)
5. **Làm tròn giờ: lựa chọn (1) hay (2)?** (1) chỉ làm tròn lên phút: giảm khoảng 37% (ước lượng), không phải đụng tới `schedule_conflicts`. (2) làm tròn lên + ngưỡng 2 phút: giảm khoảng 60% (ước lượng), nhưng giờ trên bảng có thể sớm hơn thực tế tới dưới 2 phút, và `schedule_conflicts` cần dung sai. Đề xuất (2), như đã thống nhất, với dung sai chỉ khi một bên là giờ thật.
6. **Dữ liệu cũ có số giây:** để nguyên (đề xuất) hay sửa lại một lần bằng migration?
7. **"Gia hạn tối đa" mặc định 30 phút** cho mọi ngày, kể cả ngày cuối? Và xếp được một phần (ví dụ 3/5 trận) thì **không** đề nghị gia hạn, đúng không?
8. **Đồng ý câu chữ bổ sung cho AGENTS.md** ở mục 3.4?
9. **Thứ tự và cách chia PR:** 3.3 → 3.1 → 3.2, ba PR riêng?
