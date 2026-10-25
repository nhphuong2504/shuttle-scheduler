# Audit vận hành end-to-end — Viet Nam Open 2026 trên Tournova

*Ngày audit: 2026-10-24. Dữ liệu: snapshot `analysis/viet-nam-open-2026` (commit `faed7f6`). Code đối chiếu: `main` @ `d63b94a`. Toàn bộ giờ là giờ địa phương `America/Chicago`.*

> **Cập nhật 2026-10-25.** Sau khi chạy lại chính bộ xếp lịch của ứng dụng trên trạng thái thật của giải, nguyên nhân gốc của A3 đã được xác định, và nó cũng là điểm khởi đầu của A1. Xem **§8**. Các lỗi này đã được sửa ở Đợt 1 (nhánh `fix/scheduler-silent-failures`) và Đợt 2 (nhánh `feat/desk-start-guard`).

**Ký hiệu loại phát hiện:** `BUG` lỗi · `LIMIT` giới hạn của thuật toán/thiết kế · `UX` trải nghiệm vận hành · `EXPECTED` đúng thiết kế · `OPT` cơ hội tối ưu · `CONFIG` do cấu hình thử nghiệm · `SIM` hiện vật của việc mô phỏng.
**Mức bằng chứng:** **[Sự kiện]** đọc thẳng từ dữ liệu · **[Suy luận]** rút ra từ dữ liệu và code · **[Giả thuyết]** chưa kiểm chứng được bằng dữ liệu hiện có.

---

## 0. Kết luận

**Tournova chưa sẵn sàng vận hành một giải thật nhiều nội dung nếu chưa sửa các mục P0. Phần lõi thì đã đáng tin cậy.**

Các phần hoạt động tốt:

- Ràng buộc cứng được giữ tuyệt đối: không có trận nào trùng sân hay trùng VĐV, không trận knockout nào bắt đầu trước khi trận nhánh của nó kết thúc, và cả 70 lần chuyển trận knockout đều có ≥ 10 phút nghỉ.
- Vòng 2 và các nhánh đấu được tự sinh trong vòng 1 giây sau kết quả cuối cùng.
- Live reflow giữ lịch ngày 1 sát với giờ công bố: 96% trận placement bắt đầu trong vòng 10 phút so với giờ công bố đầu tiên.

Điểm yếu nằm ở lớp xử lý **khi thực tế lệch khỏi kế hoạch**:

- Mỗi trận gắn cứng vào một sân.
- Reflow chỉ đẩy lùi và chỉ đẩy theo thứ tự đã công bố.
- Một trận đã quá giờ mà đang bị chặn thì không được hệ thống tự sửa.
- Desk chỉ cho thấy một trận kế tiếp cho mỗi sân.

Ngày 2, một lần bắt đầu trận ngoài kế hoạch đã làm sân 2 đứng yên **99 phút** với ba trận "quá giờ" xếp chồng. Chuỗi trận của Do Van bị đẩy dồn về cuối ngày, và giải kết thúc lúc **16:44**. Một bộ xếp lịch tham lam (greedy) đơn giản, dùng cùng thời lượng thực tế và cùng luật, kết thúc khoảng **15:23** (ước lượng, xem §3.7). Phải tới khi người vận hành bấm Rebuild thủ công lúc 14:02:59 thì tình trạng này mới được gỡ.

| Chỉ số | Ngày 1 | Ngày 2 |
| --- | ---: | ---: |
| Số trận | 46 placement | 5 placement + 31 knockout |
| Cửa sổ / thực tế | 15:04–17:00 / 15:04:52–16:59:06 | 12:01–18:30 / 12:01:07–16:44:07 |
| Tỉ lệ dùng sân trong thời gian thực chạy | 0,60 | 0,36 |
| Phút trận phải chờ dù VĐV đã sẵn sàng, chỉ vì sân của nó bận trong khi sân khác trống | 30 phút / 5 trận | 94 phút / 7 trận |
| Phút-sân "có sân trống *và* có trận đủ điều kiện" (cận trên, xem §1.3) | ≤ 124 | ≤ 320 |
| Kết thúc thực tế so với mô phỏng greedy cùng luật | — (cả hai đều không kịp 17:00) | 16:44 so với ≈ 15:23 |

**5 phát hiện quan trọng nhất:**

1. **Trận quá giờ bị chặn làm "đóng băng" một sân** (§6-A1). `BUG`/`LIMIT` + `UX`, **P0**.
2. **Trận được bắt đầu khi chưa có giờ công bố thì reflow không nhìn thấy** (§6-A2). Hai trận ngày 2 rơi vào trường hợp này, và một trong hai là nguyên nhân gốc của #1. `BUG`, **P0**.
3. **Lịch gắn cứng vào sân, Desk chỉ hiện một trận cho mỗi sân.** Trận sẵn sàng phải chờ sau một trận chạy quá giờ trên sân của nó trong khi 4–7 sân khác trống (§6-A6). `LIMIT` + `UX`, **P0/P1**.
4. **Tự xếp lịch (place-ready) có lúc im lặng không xếp.** Các trận nhánh XD không có giờ trong khoảng 11 phút; `MS draw A r1 s2` không bao giờ được xếp giờ (§6-A3). ~~Chưa xác định được nguyên nhân. **P1**.~~ **Đã xác định (§8): bộ xếp lịch bị crash, và đây chính là điểm khởi đầu của #1. `BUG`, P0, đã sửa ở Đợt 1.**
5. **Ngày 1 không thể chứa đủ 51 trận placement.** Đây là giới hạn công suất do cấu hình (cửa sổ 116 phút, slot 10 phút trong khi trận thực tế trung bình 11,8 phút, VĐV đánh tới 3 nội dung), không phải lỗi thuật toán. Dù vậy hệ thống không cảnh báo trước được điều này (§6-A4, §6-A11). `CONFIG` + `UX`, **P1**.

---

## 1. Phạm vi, phương pháp và giới hạn của dữ liệu

### 1.1 Dữ liệu đã dùng

`matches.csv` (51), `draw-matches.csv` (39, trong đó 8 bye), `desk-activity.csv` (598 dòng, 575 dòng còn gắn với trận), `teams.csv`, `tournament.json` (settings, `day_courts` rỗng, nghĩa là cả 8 sân dùng được ở cả hai ngày) và `summary.json`.

Code đã đối chiếu:

- `shift_live_schedule_core` (bản mới nhất: `20261023000000_prerequisite_order.sql`);
- `assert_can_start_match` (`20261010000000_…`);
- `src/lib/tournament/desk.ts`, đoạn tính `readyUnassigned` trong `desk.tsx`;
- `auto-schedule.ts`, `useAutoSchedule.ts`, `capacity-estimate.ts`;
- `docs/scheduling-decisions.md` §25–31 và `docs/desk-notifications.md`.

### 1.2 Phương pháp

1. **Dựng lại bảng điều phối.** Phát lại `desk_activity` theo thứ tự để biết tại mỗi thời điểm, trên mỗi sân, Desk đang hiển thị trận nào với giờ nào.
2. **Kiểm tra đủ điều kiện từng nửa phút.** Một trận được coi là đủ điều kiện khi đã được sinh ra, các trận nhánh và trận tiên quyết đã xong, mọi VĐV đều không đang thi đấu và đã nghỉ đủ (5 phút trước trận placement, 10 phút trước trận knockout).
3. **Mô phỏng greedy đối chứng.** Dùng 8 sân và thời lượng thực tế của từng trận, giữ đúng các luật (cổng cả vòng cho số lượng lẻ, trận makeup, nhánh đấu chỉ được tạo khi placement xong, thời gian nghỉ), cộng 0,5 phút đổi trận, ưu tiên VĐV có tải còn lại lớn nhất.

Script nằm ở thư mục scratchpad của phiên này. Chúng không phải code của ứng dụng.

### 1.3 Giới hạn bắt buộc phải biết khi đọc báo cáo

- **`SIM` Thời lượng trận chủ yếu là độ trễ bấm nút.**
  - Toàn bộ 575 dòng hoạt động đến từ **một** `actor_id`.
  - Kết quả được nhập theo cụm: bốn kết quả trong 13:28:45–13:29:02; các cụm 16:45:12/14/16, 12:12:30/33/37, 15:31:50/53/56.
  - Tỉ số được lặp lại theo mẫu (21-14, 21-14).
  - Vì vậy các trận "44–47 phút", tỉ lệ 87–90% trận vượt slot, khoảng lặng 13:29→13:53 với 7 sân trống và cụm bắt đầu 14:24→14:36 **không** thể đọc như hành vi thi đấu thật.
  - Câu hỏi thật còn lại là: *khi người vận hành chậm hoặc vắng mặt, Desk có làm tình huống đủ "ồn" để họ biết không?*
- **`SIM` Cấu hình thử nghiệm:** ngày 1 chỉ có 116 phút, slot placement 10 phút (đấu 1 game tới 21) và nghỉ 5 phút. Các vấn đề sinh ra từ đây được đánh dấu `CONFIG`.
- **Các nhánh chưa được kiểm thử:**
  - Cả 5 nội dung đều có số lượng lẻ (13/9/9/7/13), nên đường vòng 2 tăng dần (chỉ dành cho số lượng chia hết cho 4) **chưa từng chạy**.
  - Không có walkover, sửa kết quả, reset, rút lui hay đổi sân vì hỏng sân.
  - Chỉ có một người vận hành trên một thiết bị, và không có thử nghiệm mất mạng.
  - Tính năng Call next mới có từ ngày 2 (commit `e4a6736`, 01:00 ngày 24) nhưng không để lại dữ liệu sử dụng.
- **Hai chỉ số "phút-sân bị mất" (124/320) là cận trên.** Phép kiểm tra không nhìn trước, nên có trường hợp trận đủ điều kiện ngay lúc đó nhưng sẽ va vào trận đã công bố tiếp theo của chính VĐV đó (ví dụ MS r2-5 lúc 16:04 sẽ chạm MD r2-2 của Mai Khoa lúc 16:09). Con số đáng tin hơn là **thời gian chờ do gắn sân trong khi có sân khác trống**: 30 phút ở ngày 1 và 94 phút ở ngày 2.
- **Mô phỏng greedy chỉ là ước lượng.** Nó dùng thời lượng thật, tức là biết trước tương lai, và giả định người vận hành phản ứng tức thì. Nên đọc nó như "mức có thể đạt nếu điều phối linh hoạt", không phải con số cam kết. Báo cáo chỉ trích dẫn lần chạy tất định theo ưu tiên tải; lần tốt nhất trong 200 lần chạy ngẫu nhiên thì thiên lệch.

---

## 2. Diễn biến theo thời gian

### Ngày 1 — thứ Sáu 23/10, 15:04–17:00

| Giờ | Sự kiện | Ghi chú |
| --- | --- | --- |
| 15:03:07 | Build lần đầu, đặt 23 trận vòng 1 lúc 15:02 | Bị bỏ, rồi thay hoàn toàn ở 15:04:39. Không có hai trận nào cùng sân cùng giờ. |
| 15:04:39 | Build chính thức với 23 trận vòng 1 | Lớp 15:04 (8 sân), lớp 15:19 (8), 15:29 (2), 15:34 (4), 15:49 (1). Vòng 1 dự kiến khép: WD/MD 15:14, WS 15:29, XD 15:44, **MS 15:59** (chỉ còn một trận MS r1-2). |
| 15:04:52–15:05:04 | 8 sân bắt đầu cùng lúc | Desk phản ứng tốt. |
| 15:16:24 / 15:18:34 / 15:32:46 / 15:53:07 / 16:03:33 | Vòng 2 của WD / MD / WS / XD / MS được sinh và xếp giờ **≤ 1 giây** sau kết quả cuối của vòng 1 | Tự động hoá chạy đúng. |
| 15:53:07 | XD vòng 2 được xếp: r2-3 lúc 16:23, r2-1/2 lúc 16:36, mk1/r2-4 lúc 16:41; **r2-5 và mk2 sang 12:01 ngày 2** | Đúng thiết kế với `strictClose`: không tìm được chỗ trước 17:00. |
| 16:03:33 | MS vòng 2: 4 trận ở ngày 1; **r2-1, mk2, r2-4 sang ngày 2** | Đã kiểm chứng qua các trận đã công bố của Do Huy (§6-A4). |
| 16:23:12 / 16:34:39 / 16:47:20 | Nhánh WD / MD / WS được tạo, tất cả xếp sang ngày 2 | |
| 16:36:03 → 16:47:52 | XD mk2 bị chuyển 12:01 (ngày 2) → **17:01 ngày 1** (sau giờ đóng) → trả về 12:01 | Rất có thể là sửa tay (§6-A5). |
| 16:55:10 → 16:55:39 | XD r2-5 được kéo sang sân 8 lúc 16:55 rồi trả về sau 29 giây | Thao tác tay (§6-A5). |
| 16:59:06 | Trận cuối cùng của ngày 1 kết thúc | 46/51 trận placement đã xong. |

Sân 8 trống từ 15:35 tới hết ngày (84 phút). Sân 7 trống 15:32–16:26 và từ 16:39 tới hết ngày.

### Ngày 2 — thứ Bảy 24/10, 12:01–18:30, kết thúc thực tế 16:44

| Giờ | Sự kiện | Ghi chú |
| --- | --- | --- |
| 12:01 | 4 trận bắt đầu đúng giờ: XD r2-5, XD mk2, MS r2-1, WD D r1 s1 | Sân 5–8 trống, và không trận nào khác đủ điều kiện. Hợp lệ. |
| ~12:12:33 | XD placement xong, nhánh XD được tạo | **Các trận nhánh XD không được xếp giờ cho tới 12:23:24** (§6-A3). |
| 12:14:13 | Desk bắt đầu **XD C r1 s1** (Ly Van) từ danh sách "ready, unassigned", trên sân 6, không có giờ công bố | Ly Van vốn đã được công bố ở **WD A r1 s1 lúc 12:21, sân 2**. |
| 12:25 | WD A r1 s1 trở thành trận **quá giờ và bị chặn** (Ly Van đang đánh) | Bắt đầu chuỗi sự cố §6-A1. |
| 12:30:52 | Nhánh MS được tạo; 4 trận được xếp lúc 13:52–13:55; **MS A r1 s2 không được xếp** | 12:31:46: Desk bắt đầu trận này khi chưa có giờ. |
| 12:44:31 | WS B r1 s1 (Dinh Giang) bắt đầu **sớm 10,6 phút** | Lấy mất Dinh Giang, người cũng thuộc WD A r1 s1. |
| 12:55 → 14:03 | Sân 2: WD A @12:25, WS A @12:55, XD A @13:25 **không được dời giờ**; sân 2 trống | WS A r1 s2 (Do Van – Ly Ngoc) đủ điều kiện suốt 12:55–13:29 nhưng nằm sau WD A. |
| 13:28:45–13:29:02 | 4 kết quả được nhập trong 17 giây | `SIM` |
| 13:29–13:53 | 7 sân trống, tới 6 trận đủ điều kiện | `SIM` (người vận hành tạm vắng), nhưng Desk không có cảnh báo nào ở mức sân. |
| 14:02:59 | Người vận hành bấm **Rebuild**: xoá 10 trận, ghi lại 10 trận | Sân 2 được gỡ sau **98 phút**. |
| 15:21 | WD A r1 s1 được đánh: **muộn 180 phút** so với giờ công bố đầu | |
| 16:28–16:44 | Chung kết XD A, trận cuối cùng của giải | Nằm trên chuỗi trận của Do Van. |

---

## 3. Thuật toán scheduling

### 3.1 Build ban đầu (ngày 1) — tốt, còn chỗ tối ưu nhỏ

- **[Sự kiện]** 8/8 sân được dùng ngay ở 15:04 và ở lớp 15:19. Các nội dung được trộn để VĐV đánh nhiều nội dung có thời gian nghỉ. Kế hoạch không vi phạm ràng buộc nào.
- **[Sự kiện]** Kế hoạch khép vòng 1 của MS muộn nhất (15:59). Lý do: một trận duy nhất, MS r1-2 (Duong Thanh – Do Anh), bị đặt ở 15:49. Thực tế MS vòng 1 khép lúc **16:03:32**. Vì MS có số lượng lẻ, vòng 2 phải đợi **cả vòng 1**, nên vòng 2 MS chỉ mở lúc 16:03:33. Đây chính là nguyên nhân trực tiếp khiến 3 trận MS vòng 2 tràn sang ngày 2.
- **[Suy luận]** Cận dưới của chuỗi trận cho Duong Thanh và Do Anh (mỗi người 3 trận vòng 1: MD, XD, MS) là 15:04 + 3×15 − 5 = **15:44**. Khoảng 15 phút chênh có thể đến từ ràng buộc chéo (Le Nhung đánh WD, WS và XD), hoặc từ việc thuật toán chưa ưu tiên khép đúng giai đoạn "nút cổ chai". `OPT` **[Giả thuyết — cần chạy `strategy-replay` với dữ liệu này để xác nhận]**.
- **[Sự kiện]** Kế hoạch ban đầu chỉ đặt 2 trận vào sân 7 và 8 rồi để trống. Với ràng buộc VĐV dày như vậy, thời điểm bắt đầu bị khoá bởi VĐV chứ không phải bởi sân, nên đây không phải lãng phí trong kế hoạch. Tuy nhiên nó **dồn trận vào sân 1–5**, và hệ quả là ở §3.4.

### 3.2 Tuân thủ ràng buộc — đạt

| Ràng buộc | Kết quả |
| --- | --- |
| Trùng sân hoặc trùng VĐV trong thực tế | **0** **[Sự kiện]** |
| Knockout bắt đầu trước khi trận nhánh xong | **0** |
| Nghỉ tối thiểu ở knockout (10 phút) | 70 lần chuyển trận, nhỏ nhất 10,1 phút, trung vị 24 phút |
| Nghỉ tối thiểu ở placement (5 phút) | 1 trường hợp dưới ngưỡng: Bui Nguyet 4,6 phút. Reflow công bố đúng end + 5 phút, nhưng Desk bắt đầu sớm 25 giây; `block_start_on_short_rest = false` nên chỉ có cảnh báo. Dữ liệu không cho biết cảnh báo có hiện ra và bị bỏ qua hay không. |
| Thứ tự makeup (`prerequisite_ids`) | **1 vi phạm**: WS r2-makeup-2 bắt đầu lúc 16:34:44, trong khi hai trận tiên quyết WS r2-1 và r2-2 vẫn đang đánh (kết thúc 16:45). Hàm kiểm tra khi bắt đầu trận (`assert_can_start_match`) **không kiểm tra trận tiên quyết** (§6-A8). |
| Giờ đóng cửa | `strictClose` được tôn trọng: không trận tự động nào được đặt vượt 17:00 **[Sự kiện]**. Có một lần ghi 17:01, sau giờ đóng, rất có thể là sửa tay **[Suy luận — chưa xác định writer]** (§6-A5). |

### 3.3 Tự sinh vòng tiếp theo — tốt

Vòng 2 và nhánh đấu được sinh trong vòng ≤ 1 giây sau kết quả mở khoá, ở cả 5 nội dung. Người vận hành không cần bấm gì. Đây là điểm mạnh nên giữ nguyên. `EXPECTED`

### 3.4 Tự xếp lịch (`place-ready`) — đúng thiết kế nhưng thiết kế có hai cái giá

- **"Held means held".** Mọi trận đã công bố là cái mốc cố định, và trận mới chỉ được chèn vào khoảng trống còn lại.
  - **[Sự kiện]** WS r2-makeup-1 (Ly Ngoc – Ho Thuy) đủ điều kiện từ khoảng 15:41 nhưng bị đặt ở 16:07, sau WD r2-1 của Ly Ngoc (đã công bố 15:51). Trong 15:41–15:56 có 2–7 sân trống.
  - **[Sự kiện]** Ngày 2: trận nhánh XD và MS đều bị đặt **sau** mọi mốc đã công bố của VĐV liên quan (13:09–13:55), trong khi lúc đó có 3–5 sân trống.
  - Đây là đánh đổi có chủ đích để lịch ổn định cho VĐV (`EXPECTED`). Cái giá là lịch "lớn dần về bên phải" theo từng đợt, và **mốc sai không bao giờ được sửa** (xem A1).
- **Chọn sân.** **[Suy luận]** Khi thời điểm bắt đầu bị khoá bởi VĐV, sân được chọn theo thứ tự (sân số nhỏ trước). Ngày 2, place-ready chỉ đặt trận vào sân 1–5 cho tới 13:28; sân 8 không được dùng lần nào. Vì Desk và reflow đều gắn trận với sân, việc dồn sân biến một trận chạy quá giờ thành độ trễ cho các trận phía sau, trong khi sân khác đang trống (§6-A6). `OPT`
- **Độ tin cậy.** Hai lần xếp lịch không thành công mà không để lại dấu vết (§6-A3).

### 3.5 Live reflow — đúng ở trường hợp phổ biến, hổng ở trường hợp lệch kế hoạch

- **[Sự kiện]** Ngày 1, reflow giữ lịch rất sát: 65% trận placement bắt đầu trong vòng 5 phút so với giờ công bố đầu tiên, 96% trong vòng 10 phút. Trễ trung bình so với giờ công bố cuối là +0,9 phút.
- **[Suy luận từ code `shift_live_schedule_core`] Bốn khoảng hổng:**
  1. **Không bao giờ kéo sớm hoặc đổi sân.** Một trận ngắn để lại khoảng trống không ai lấp; một trận dài làm cả hàng của sân đó chờ. `LIMIT` (có chủ đích).
  2. **Không xử lý trận đã quá giờ.** Hàng đợi chỉ gồm các trận có `original_time > source_time` trên cùng sân hoặc có chung VĐV. Trận đã quá giờ và bị chặn bởi một VĐV đang đánh ở sân khác **giữ nguyên giờ cũ**, vì không có sự kiện nào trên sân đó kích hoạt reflow. → A1. `BUG`
  3. **Trận bắt đầu khi chưa có giờ hoặc sân công bố** bị loại khỏi `live_schedule_work`, nên thời gian bận của VĐV trong trận đó vô hình với reflow. → A2. `BUG`
  4. **Nhiễu:** 309 dòng `time-shifted`, trong đó **186 dòng (60%) dịch dưới 1 phút**. Giờ công bố mang độ chính xác tới giây (ví dụ 14:03:14). WD A r1 s1 bị dời 16 lần. `UX`

### 3.6 Công suất và việc tràn sang ngày 2

- **[Sự kiện + mô phỏng]** Với thời lượng thực tế và đúng các luật, greedy ưu tiên tải cũng chỉ xong 51 trận placement lúc **17:23**. Với `strictClose`, 7 trận XD vòng 2 sẽ không xếp được trước 17:00. Thực tế hệ thống chỉ để lại 5 trận.
  → **Hiện tượng tràn ngày là do công suất và cấu hình, không phải thuật toán kém.** Thuật toán thực tế làm ngang hoặc tốt hơn mức đối chứng. `CONFIG`/`EXPECTED`
- Các yếu tố gây ra:
  - Cửa sổ ngày 1 chỉ 116 phút.
  - 5 VĐV (Bui Nguyet, Cao Binh, Do Van, Huynh Trang, Truong Diep) có **6 trận trong 112–114 phút**, nghĩa là riêng chuỗi của họ đã ≈ 6×(11,8 + 5) ≈ 100 phút.
  - Cổng "cả vòng" của số lượng lẻ.
  - Slot 10 phút trong khi trận thực tế trung bình 11,8 phút (và đó là độ trễ bấm nút ở trong mô phỏng).

### 3.7 Ngày 2 đáng lẽ có thể xong sớm hơn nhiều

- **[Mô phỏng]** Cùng 36 trận, cùng thời lượng thực, cùng luật: greedy tất định ưu tiên tải kết thúc **≈ 15:23**, và **≈ 15:13** nếu giới hạn ba trận "44–47 phút" (hiện vật mô phỏng) ở 25 phút. Kết quả **không đổi** khi thời gian đổi trận trên cùng sân là 0,5, 3, 5 hay 6 phút (mức 5–6 phút là mức thực tế ở ngày 1). Lý do: đường găng bị khoá bởi thời gian nghỉ 10 phút của VĐV, không phải bởi sân. Thực tế kết thúc 16:44. Phần chênh **≈ 80 phút** là ước lượng có thể đạt được với điều phối linh hoạt. Không nên coi đó là lỗi đo được chính xác.
- **[Sự kiện]** Đường găng thực tế là chuỗi của Do Van: WS A r1 s2 14:04 → XD A r1 s1 14:46 → WD A r1 s1 15:21 → WS A r2 15:57 → XD A r2 16:28–16:44. Ba trận đầu của chuỗi này **đã được công bố lúc 12:21, 12:51 và 13:23** và đều bị kẹt sau sự cố ở sân 2.

### 3.8 Nguồn gốc của từng vấn đề

| Vấn đề | Thuật toán | Dữ liệu / cấu hình | Ràng buộc hợp lệ | Thao tác vận hành |
| --- | :-: | :-: | :-: | :-: |
| 5 trận tràn sang ngày 2 | nhỏ (MS r1 khép muộn) | **chính** (116 phút, slot 10) | **chính** (VĐV 3 nội dung, cổng cả vòng) | — |
| Sân 2 đứng yên 99 phút | **chính** (reflow, gắn sân) | — | một phần (VĐV bận thật) | khởi phát (bắt đầu trận ngoài kế hoạch, bắt đầu sớm) |
| Nhánh XD 11 phút không có giờ; MS A r1 s2 không được xếp | **chính** (chưa rõ cơ chế) | — | — | — |
| Trận chờ sau trận chạy quá giờ trên cùng sân, sân khác trống | **chính** (gắn sân) | — | — | phụ |
| 13:29–13:53 có 7 sân trống | — | — | — | **chính** (`SIM`) |
| Trận 44–47 phút, 90% trận vượt slot | — | **chính** (`SIM`, slot ngắn) | — | **chính** |

---

## 4. Trải nghiệm người điều hành (Desk / Organizer)

### 4.1 Những gì tốt

- **Khối lượng thao tác thấp.** Cả giải gồm 82 lần bắt đầu, 82 lần nhập kết quả, **1** lần Rebuild và 4 lần sửa tay (2 lần thử rồi hoàn tác, §6-A5). Không phải bấm "sinh vòng 2", "tạo nhánh" hay "xếp lịch" lần nào. Hệ thống thực sự giảm việc cho người vận hành ở luồng chuẩn.
- **Trạng thái sân rõ.** Mỗi sân có trạng thái `playing`, `overrun`, `free-ready` hoặc `free-blocked`, kèm lý do sẵn sàng ("X đang đánh ở sân N", "đang nghỉ, còn k phút"). Lý do này lấy từ cùng một hàm với dialog bắt đầu trận, nên hai nơi không thể nói khác nhau.
- **Ngày 1 vận hành đều.** Thời điểm bắt đầu trung bình chỉ lệch +0,9 phút so với giờ công bố, nên người vận hành có thể "đi theo giờ" mà không phải suy luận.
- **Liền mạch giữa các bước.** Nhập kết quả → vòng sau tự sinh → tự xếp giờ → nhánh tự tạo. Người vận hành không phải rời Desk.

### 4.2 Những chỗ đúng về kỹ thuật nhưng không tốt khi vận hành

| # | Vấn đề | Bằng chứng | Loại |
| --- | --- | --- | --- |
| U1 | **Mỗi sân chỉ cho thấy 1 trận kế tiếp** (`deriveCourtState` lấy trận `scheduled` sớm nhất trên sân đó). Khi trận đầu hàng bị chặn, các trận phía sau, dù đã đủ điều kiện, không được đề xuất. | Sân 2, 12:55–13:29: WS A r1 s2 đủ điều kiện nhưng tile chỉ hiện WD A r1 s1 với trạng thái "free-blocked". | `UX` **P0** |
| U2 | **Trận quá giờ không gây "ồn".** Danh sách "Needs action/Up next" đã bị bỏ; xung đột lịch không còn hiện trên tile mà chỉ ở trang Schedule của organizer. | Lúc 13:29 sân 2 có 3 trận quá giờ 4–64 phút; không có cảnh báo nào ở mức sân. | `UX` **P0** |
| U3 | **Bắt đầu một trận trong danh sách "ready, unassigned" không cảnh báo hệ quả.** Desk không nói "VĐV này đã có trận lúc 12:21 ở sân 2". | XD C r1 s1 lúc 12:14 làm hỏng WD A r1 s1 (§6-A1, A2). | `UX` **P0** |
| U4 | **Bắt đầu sớm không cảnh báo khi lấy mất VĐV của một trận đang quá giờ ở sân khác.** | WS B r1 s1 bắt đầu sớm 10,6 phút và lấy Dinh Giang khỏi WD A. | `UX` **P1** |
| U5 | **Cách gỡ tự nhiên nhất là Rebuild, mà Rebuild thuộc phía organizer.** Gợi ý rebuild chỉ hiện trên trang Schedule khi rebuild giúp sớm ≥ 30 phút. Dialog trận trên Desk *có* "Check constraints and update" để chọn sân và giờ bằng tay, nhưng phải tự chọn sân, tự gõ giờ, và Desk không bao giờ gợi ý dùng nó. | Rebuild lúc 14:02:59, 98 phút sau khi WD A bị kẹt. | `UX` **P1** |
| U6 | **Câu hỏi "có nhét trận này vào cuối ngày được không?" không có câu trả lời**, nên người vận hành thử rồi tự hoàn tác. | 16:36 / 16:47 (XD mk2), 16:55:10 / 16:55:39 (XD r2-5). | `UX` **P1** |
| U7 | **Giờ công bố dao động liên tục.** 60% số lần dời là dưới 1 phút, giờ hiển thị tới giây. | 309 dòng `time-shifted`. | `UX` **P1** |
| U8 | **"Will it fit?" định giá trận theo slot mặc định 20/25 phút**, không theo slot đã cấu hình 10/20 (`src/components/capacity-estimate.tsx:28`). Đây là chủ ý đã ghi trong `docs/tournament-format.md` ("prices them at the default 20 / 25 minute slots"). Ước lượng tính trên **cả giải**, không theo ngày hay theo chuỗi trận của VĐV. | Ngày 1 quá tải không được báo trước. **[Suy luận — không có ảnh chụp màn hình]** | `UX`/`LIMIT` (khoảng trống thiết kế, không phải bug) **P1** |
| U9 | **Tự xếp lịch thất bại mà không để lại dấu vết.** Trận nằm trong pool "ready, unassigned" nhưng VĐV không có giờ để đến. | §6-A3. | `BUG`? **P1** |
| U10 | **Desk cho bắt đầu trận khi trận tiên quyết đang diễn ra.** | WS mk2 (§6-A8). | `BUG` nhẹ **P2** |

### 4.3 Có lúc nào người vận hành phải tự suy luận hoặc can thiệp?

Có, ở bốn thời điểm:

- **12:14 và 12:31:** tự chọn trận không có giờ để đánh.
- **12:25 → 14:02:** phải tự nhận ra sân 2 bị kẹt và quyết định Rebuild.
- **16:36 và 16:55:** tự thử kéo trận XD về cuối ngày 1.
- **Cuối ngày 2:** trạng thái giải vẫn là `in_progress`. Nút Complete chỉ được thêm sau giải (commit `6d13a15`).

Mỗi lần trong số này, hệ thống đều đã có đủ dữ liệu để tự đề xuất.

---

## 5. Trải nghiệm VĐV

### 5.1 Ngày 1 — ổn định, nhưng rất dày

- **Dễ đoán.** Giờ công bố đầu tiên đáng tin: lệch trung bình +4,3 phút, tối đa 11,4 phút. VĐV có thể dựa vào lịch.
- **Mật độ cao.**
  - 5 VĐV đánh **6 trận trong 112–114 phút**, thời gian trên sân chiếm ~60% khoảng đó, khoảng nghỉ ngắn nhất ~5 phút.
  - 8 VĐV khác đánh 5 trận.
  - Hợp lệ theo luật nghỉ 5 phút. Nhưng ở giải thật (game 21 điểm mất 12–15 phút, cộng khởi động) thì quá sức với người đánh 3 nội dung. `CONFIG`
- **Mất cân bằng.**
  - VĐV chỉ đánh 1 nội dung chờ 41–68 phút giữa hai trận (Ho Thien 67,8; Dang Diep 62,9).
  - VĐV 3 nội dung gần như không được nghỉ.
  - Đây là hệ quả tự nhiên của việc đăng ký tối đa 3 nội dung (`max_categories_per_player = 3`).
- **Trận tràn ngày.** Các trận XD r2-5, XD mk2, MS r2-1, mk2 và r2-4 đã được báo trước bằng giờ 12:01–12:16 của ngày 2 từ 15:53 / 16:03 ngày 1. Như vậy là đủ sớm và ổn định. Riêng XD mk2 từng hiện "17:01 hôm nay" trong 11 phút (16:36–16:47) do sửa tay, có thể gây nhầm lẫn cho VĐV.

### 5.2 Ngày 2 — kém ổn định, mất cân bằng lớn

- **Giờ công bố của knockout vòng 1 không đáng tin.**
  - Độ dời trung bình **+30 phút**, tối đa **+180 phút**, dù **cả hai bên đã biết ngay khi nhánh được tạo**.
  - README hiện ghi "drift của knockout là chờ trận nhánh". **Điều này không đúng với vòng 1**: WD A r1 s1 +180, XD A r1 s1 +84, WS A r1 s2 +73, XD D r1 s2 +44, MS B r1 s1 +43.
  - Ở vòng 2 (trung bình +20,5) thì mới đúng là có yếu tố chờ trận nhánh.
- **Chờ rất lâu dù có sân trống:**
  - Ly Van **166 phút** (XD C xong 12:35 → WD A 15:21);
  - Bui Yen 155 phút;
  - Ho Duc và Cao Huong 154 phút: trận XD A r1 s1 của họ, với cả 4 VĐV rảnh và nghỉ đủ từ 12:22 tới 13:53, được công bố 13:23 rồi bị đẩy tới 14:46;
  - Ho Viet 110 phút; Le Nhung 101 phút.
- **Bị dồn trận vào cuối ngày.** Do Van không đánh trận nào từ 12:00 tới 14:04. Sau đó đánh **5 trận best-of-3 trong 2 giờ 40 phút**, khoảng nghỉ 10,8–13,5 phút, gồm 4 trận chung kết hoặc bán kết. Bui Minh, Dang Nam và Do Huy đánh 6 trận, 119–130 phút trên sân trong 3–4 giờ.
- **Nghỉ tối thiểu được đảm bảo** (≥ 10,1 phút) nhưng **không phân biệt** việc vừa đánh 3 game hay 2 game. `OPT`

### 5.3 Trả lời trực tiếp các câu hỏi

| Câu hỏi | Trả lời |
| --- | --- |
| Có ai chờ lâu dù sân trống? | Có. Ngày 2 có nhiều trường hợp trên 1,5 giờ, bắt nguồn từ A1, A3 và A6. |
| VĐV nhiều nội dung bị xếp quá dày? | Ngày 1 có (6 trận trong 2 giờ). Ngày 2 có, ở dạng bị dồn về cuối ngày. |
| Nghỉ tối thiểu được đảm bảo trong mọi tình huống? | Gần như có: 1 trường hợp 4,6 phút ở placement do bắt đầu sớm 25 giây, và 1 trường hợp makeup bắt đầu trước khi trận tiên quyết xong. |
| Lịch đủ ổn định để VĐV biết khi nào cần có mặt? | Ngày 1: có. Ngày 2: không. Giờ công bố của knockout vòng 1 có thể sai tới 3 giờ. |
| Có thay đổi bất ngờ? | Có: XD mk2 nhảy giữa hai ngày; XD C r1 s1 và MS A r1 s2 được gọi ra sân khi chưa từng có giờ. |

---

## 6. Phân tích các tình huống bất thường

### A1. Sân 2 đứng yên 99 phút với ba trận "quá giờ" — **P0**

1. **Thời điểm và bối cảnh.**
   - Ngày 2, sân 2 có hàng đợi: WD A r1 s1 @12:21, WS A r1 s2 @12:51, XD A r1 s1 @13:23. Cả ba đều có Do Van.
   - 12:14 Desk bắt đầu XD C r1 s1 (Ly Van) ở sân 6, khi trận này chưa có giờ.
   - 12:44 WS B r1 s1 (Dinh Giang) bắt đầu sớm 10,6 phút.
   - WD A cần cả Ly Van và Dinh Giang, nên bị chặn tới khoảng 13:38.
   - Sau đó, lúc 13:53, người vận hành lại gọi Dinh Giang (XD D r1 s1) và Cao Thao (XD B r1 s2) vào các trận khác.
   - Ảnh chụp bảng điều phối lúc 13:29 và 13:45: sân 2 vẫn là `WD A@12:25 | WS A@12:55 | XD A@13:25`, và sân 2 trống.
   - Bằng chứng trực tiếp cho cơ chế: MS D r1 s2 xếp *sau* ba trận đó trên sân 2 vẫn bị reflow dời 13:55 → 14:08 → 14:09, trong khi ba trận quá giờ phía trước đứng yên.
2. **Lý tưởng.** Khi trận đầu hàng bị chặn, hệ thống nên (a) dời giờ của nó tới lúc VĐV rảnh + nghỉ, và (b) cho trận đủ điều kiện kế tiếp (WS A r1 s2, đủ điều kiện suốt 12:55–13:29) lên trước hoặc sang sân trống, đồng thời báo cho VĐV.
3. **Thực tế.** Reflow không chạm vào sân 2 (§3.5 khoảng hổng 2 và 3). Desk chỉ hiện WD A với trạng thái "free-blocked". Tình trạng kéo dài tới khi Rebuild lúc 14:02:59.
4. **Root cause.** **[Suy luận từ code]**
   - Hàng đợi của `shift_live_schedule_core` chỉ gồm trận có `original_time > source_time` trên sân của trận nguồn hoặc có chung VĐV với nó. Trận đã quá giờ nằm *trước* thời điểm của trận nguồn nên không bao giờ được đưa vào.
   - Trận XD C r1 s1 bắt đầu khi chưa có giờ nên không nằm trong `live_schedule_work`.
   - `deriveCourtState` chỉ lấy trận sớm nhất của sân.
   - Không có cơ chế tự gỡ: chỉ Rebuild mới gỡ được.
5. **Impact.**
   - 98 phút sân 2 trống.
   - Chuỗi của Do Van dời 73–180 phút và trở thành đường găng của ngày.
   - Ngày 2 kết thúc khoảng 80 phút muộn hơn mức có thể đạt (ước lượng).
   - Ly Van chờ 166 phút; Ho Duc và Cao Huong 154 phút.
   - Giờ công bố sai tới 3 giờ.
   - **Sẽ tái diễn ở giải thật** bất cứ khi nào có VĐV nhiều nội dung, có trận bắt đầu sớm, hoặc có trận gọi ngoài kế hoạch.
6. **Recommendation.** Xem P0-1, P0-2, P0-3. Sửa nhỏ, không cần viết lại thuật toán.

### A2. Trận bắt đầu khi chưa có giờ công bố thì "vô hình" với reflow — **P0**

1. **Bối cảnh.** XD C r1 s1 (12:14:13, sân 6) và MS A r1 s2 (12:31:46, sân 7) được bắt đầu từ pool "ready, unassigned". Lúc bắt đầu không có dòng `time-shifted` nào được ghi.
2. **Lý tưởng.** Khi bắt đầu, trận phải nhận `court_id` và `scheduled_time` bằng thời điểm bắt đầu để trở thành mốc cố định, rồi reflow đẩy các trận khác của 4 VĐV liên quan. Trước khi bắt đầu, Desk phải nói "Ly Van đã có WD A lúc 12:21 ở sân 2; bắt đầu trận này sẽ làm trận đó trễ ~25 phút".
3. **Thực tế.** Reflow lọc `scheduled_time IS NOT NULL`, nên trận không được đưa vào mô hình. WD A r1 s1 vẫn hiện 12:21–12:25 trong khi Ly Van đang đánh.
4. **Root cause.** Lọc trong `live_schedule_work` (`AND tdm.scheduled_time IS NOT NULL`), cộng với việc pool "ready, unassigned" không kiểm tra cam kết trong tương lai của VĐV. `BUG`
5. **Impact.** Là điểm khởi phát của A1. Giờ công bố của các VĐV liên quan sai mà không ai biết.
6. **Recommendation.** P0-2.

### A3. Tự xếp lịch im lặng không xếp: nhánh XD 11 phút, MS A r1 s2 không bao giờ — **P1**

1. **Bối cảnh.**
   - XD placement xong lúc 12:12:33, nhánh XD có ngay (XD C r1 s1 được bắt đầu lúc 12:14). Nhưng 5 trận XD còn lại **chỉ được xếp giờ lúc 12:23:24**, đúng 1 giây sau một kết quả không liên quan (WD D r1 s1).
   - Nhánh MS được xếp lúc 12:30:52, nhưng **MS A r1 s2 bị bỏ sót**. Lúc đó Duong Thanh và Vu Duc đều rảnh, sân 7 và 8 trống, và có khe 12:31–12:51 trước trận XD D r1 s2 của Duong Thanh lúc 13:09.
2. **Lý tưởng.** Trận sẵn sàng có giờ trong vòng vài giây. Nếu không xếp được thì có lý do hiện ra.
3. **Thực tế.** Không có dấu vết. Bộ thử lại (settle 1,5 giây, rồi 2/8/30 giây, tối đa 3 lần) chỉ chạy khi Desk hoặc trang Schedule đang mở. Một câu trả lời "bền vững" chỉ được thử một lần cho mỗi "tình huống".
4. **Root cause.** **[Đã xác định, xem §8]** Không phải các giả thuyết dưới đây. Nhánh XD: bộ xếp lịch bị crash (`unknown-dependency`) từ 12:12 tới 12:19. MS A r1 s2: bộ xếp lịch và server nhìn trạng thái sân 2 khác nhau. Các giả thuyết ban đầu, giữ lại để đối chiếu:
   - (a) Ba kết quả trong 7 giây (12:12:30/33/37) bị `singleFlight` gộp lại, và lần chạy sinh nhánh lập kế hoạch với cache chưa làm mới.
   - (b) Kết quả được nhập từ trang Scores, nơi không gắn reconciler.
   - (c) Server từ chối (`player_busy`/`court_busy`) và lần thử cuối rơi vào khoảng người vận hành đã bắt đầu trận.

   Dữ liệu không ghi lý do bỏ qua của `place_ready_matches`, nên không thể kết luận.
5. **Impact.** 11 phút không có giờ cho 5 trận XD. Một trận MS bị gọi ra sân khi chưa có giờ. Cả hai trực tiếp dẫn tới A2. VĐV không được báo trước.
6. **Recommendation.** P1-4: ghi lý do bỏ qua và lý do kết thúc lần thử lại vào `desk_activity` hoặc một log riêng, rồi tái hiện bằng test tích hợp (3 kết quả liên tiếp trong 7 giây, nhập từ trang Scores).

### A4. 5 trận placement tràn sang ngày 2 — `CONFIG`/`EXPECTED`, nhưng hệ thống không cảnh báo được (**P1**)

1. **Bối cảnh.** Vòng 1 MS khép lúc 16:03:32; XD vòng 1 khép 15:53:06. Lúc 15:53:07, XD r2-5 và mk2 được đặt sang ngày 2. Lúc 16:03:33, MS r2-1, mk2 và r2-4 cũng vậy.
2. **Lý tưởng.** Hoặc xếp đủ trong ngày, hoặc **báo trước từ lúc build** (15:04) rằng ngày 1 không đủ chỗ, để organizer quyết định (kéo dài giờ, thêm sân, chuyển nội dung sang ngày 2).
3. **Thực tế.** Đã kiểm chứng MS r2-1 không có khe hợp lệ. Do Huy có MD mk1 (xong khoảng 16:08 + 5), MD mk2 @16:21 và XD r2-2 @16:36. Khe sau XD r2-2 là 16:51–17:01, vượt `strictClose`. Greedy đối chứng cũng không kịp (17:23). Như vậy quyết định tràn ngày là **hợp lý**.
4. **Root cause.**
   - Cửa sổ 116 phút.
   - VĐV 3 nội dung, có người phải đánh 6 trận.
   - Cổng cả vòng của số lượng lẻ.
   - Slot 10 phút ngắn hơn thực tế.
   - Vòng 1 MS khép muộn (khả năng tối ưu, §3.1).
5. **Impact.**
   - Ngày 2 phải mở bằng 5 trận placement.
   - Nhánh MS chỉ được tạo lúc 12:30 và nhánh XD lúc 12:12 ngày 2, nên các nhánh này dời theo.
   - Một nội dung bị chia đôi vòng 2 qua hai ngày (MS: 4 trận ngày 1, 3 trận ngày 2).
6. **Recommendation.** P1-8: ước lượng công suất theo ngày, theo slot đã cấu hình, và theo cận dưới chuỗi trận của VĐV. P2-12: ưu tiên khép giai đoạn chậm nhất trong build ban đầu.

### A5. Sửa tay để "nhét" trận XD vào cuối ngày 1 rồi tự hoàn tác — **P1**

1. **Bối cảnh.**
   - 16:36:03: XD mk2 đổi từ 12:01 ngày 2 sang **17:01 ngày 1**, sau giờ đóng. Không có sự kiện bắt đầu hay kết quả nào trong giây đó. Trigger ghi mọi thay đổi `scheduled_time` mà không đổi sân thành `time-shifted`, nên README gọi đây là "reflow" là chưa chắc đúng.
   - 16:47:52: trả về 12:01.
   - 16:55:10: XD r2-5 được chuyển sang sân 8 lúc 16:55; 16:55:39 trả về.
   - Lúc 16:55, cả 4 VĐV của XD r2-5 đều rảnh và sân 8 trống.
2. **Lý tưởng.** Desk hoặc Schedule trả lời ngay "trận này kết thúc dự kiến 17:05, sau giờ đóng: vẫn đánh? (có/không)". Không cho ghi một giờ vượt giờ đóng mà không xác nhận.
3. **Thực tế.** Một giờ 17:01 (sau giờ đóng) đã được lưu. Người vận hành tự hoàn tác. **[Giả thuyết]** Họ hoàn tác vì có cảnh báo `past_closing`, hoặc vì XD mk2 còn phải chờ mk1 (bắt đầu 16:53).
4. **Root cause.** **[Suy luận]** Thao tác sửa giờ hoặc sân bằng tay không chặn giờ đóng hoặc trận tiên quyết, và không có lựa chọn "đánh vượt giờ" một cách tường minh. Cần xác định writer nào đã ghi 17:01.
5. **Impact.** Ở mô phỏng này thì nhỏ. Ở giải thật, VĐV có thể thấy giờ "17:01 hôm nay" rồi về nhà khi giờ đổi lại. Nếu đánh được XD r2-5 lúc 16:55 thì các nhánh XD đã có thể được tạo ngay từ ngày 1.
6. **Recommendation.** P1-9.

### A6. Trận chờ sau trận chạy quá giờ trên sân của nó, trong khi 4–7 sân khác trống — **P0/P1**

1. **Bối cảnh.**
   - XD A r1 s2: VĐV sẵn sàng từ 12:54 nhưng phải chờ sau WS D r1 s2 (33,8 phút) trên sân 4, bắt đầu 13:29. Chờ **34,6 phút** trong khi 5 sân trống.
   - WS B r1 s1 chờ 21,8 phút; MS B r1 s2 chờ 14,5 phút với 7 sân trống.
   - Ngày 1: XD r2-1 chờ 5,6 phút sau WS r2-2 trên sân 3 trong khi sân 6, 7, 8 trống.
   - Tổng cộng 30 phút (5 trận) ở ngày 1 và 94 phút (7 trận) ở ngày 2.
2. **Lý tưởng.** Desk đề xuất "XD A r1 s2 sẵn sàng — sân 6 đang trống — chuyển và bắt đầu".
3. **Thực tế.** Reflow chỉ dời giờ trong cùng một sân. Place-ready dồn trận vào sân số nhỏ. Desk chỉ nhìn từng sân riêng lẻ.
4. **Root cause.** Thiết kế gắn sân từ lúc xếp lịch (`LIMIT`), cộng với cách chọn sân không phân tán (`OPT`).
5. **Impact.** Trễ cộng dồn qua các trận phía sau. Ở giải thật, một trận best-of-3 kéo dài tới 3 game là chuyện thường, nên đây là kịch bản *phổ biến*, không chỉ là hiện vật của mô phỏng.
6. **Recommendation.** P0-3 (đề xuất đổi sân trên Desk), P1-5 (phân tán sân khi xếp).

### A7. Nhiễu dời giờ và giờ công bố tới từng giây — **P1**

**[Sự kiện]**

- 186/309 lần dời nhỏ hơn 1 phút.
- Một số giờ công bố mang tới giây: 14:03:14, 15:21:08.
- Mỗi trận bị dời trung bình 4,6 lần; WD A r1 s1 bị dời 16 lần.

Hệ quả:

- Bảng công khai liên tục đổi số.
- Nhật ký hoạt động bị pha loãng (60% là nhiễu), làm khó cho việc audit.
- Nếu Call next hoặc thông báo dựa vào giờ, VĐV sẽ bị làm phiền.

Đề xuất P1-7.

### A8. Trận makeup bắt đầu trước khi trận tiên quyết kết thúc — **P2**

**[Sự kiện]** WS r2-makeup-2 (Ly Ngoc – Dang Diep) bắt đầu lúc 16:34:44, trong khi WS r2-1 và r2-2 (thuộc `prerequisite_keys`) đang đánh từ 16:28 tới 16:45.

- Giờ công bố của nó (16:38 = 16:28 + 10) khớp với kế hoạch, nên `schedule_conflicts` không báo gì.
- Desk bắt đầu sớm 3,7 phút.
- `assert_can_start_match` chỉ kiểm tra sân bận, VĐV bận và thời gian nghỉ. **Không kiểm tra trận tiên quyết.**

Ảnh hưởng thực tế thấp, vì đối thủ của trận makeup đã cố định sẵn. Nhưng nó phá vỡ luật xen kẽ makeup đã ghi trong `tournament-format.md`. Đề xuất: thêm một cảnh báo (không chặn) khi bắt đầu.

### A9. Rest 4,6 phút của Bui Nguyet — `EXPECTED` theo cấu hình

Reflow công bố WD r2-mk1 ở đúng 15:56:43 (= 15:51:43 + 5), và Desk bắt đầu lúc 15:56:18. Với `block_start_on_short_rest = false` thì đây là cảnh báo có thể bỏ qua. Không có log nào cho biết cảnh báo đã hiện ra hay chưa. Không cần sửa. Có thể cân nhắc bật `block_start_on_short_rest` cho giải thật.

### A10. Khoảng lặng 13:29–13:53: 7 sân trống, tới 6 trận đủ điều kiện — `SIM`

Bốn kết quả được nhập trong 17 giây, rồi 24 phút không có lần bắt đầu nào. Sau đó 4 trận bắt đầu cùng lúc 13:53:17–22, đều trễ 14–15 phút so với giờ công bố. Đây là hiện vật của mô phỏng (người vận hành vắng mặt). Câu hỏi thật là liệu Desk có báo "4 sân sẵn sàng đã quá giờ > 10 phút" đủ to hay không. Hiện tại Desk không làm điều đó (U2).

### A11. "Will it fit?" và README đọc sai số liệu — **P1/P2**

- `CapacityEstimate` không truyền slot đã cấu hình, nên trận placement bị định giá 20 phút thay vì 10. Đây là chủ ý theo `docs/tournament-format.md`, nên đúng hơn là một khoảng trống thiết kế (`LIMIT`/`UX`). Ước lượng còn tính trên cả giải chứ không theo từng ngày. **[Suy luận từ code]**
- Con số "carried drift" 1146 và 1140 phút của XD r2-5 và mk2 sinh ra từ các lần sửa tay lúc 16:55 và 16:36. `first_published_time` lấy giờ *sớm nhất từng được ghi*, nên đã nhặt phải hai giờ sửa tay đó. Thực ra, ngay lúc build (15:53:07) cả hai đã được công bố 12:01 ngày 2 và được đánh đúng 12:01, nên **độ dời thật ≈ 0**. Với VĐV, lịch của các trận tràn ngày là ổn định.
- `README.md` của snapshot ghi "Knockout drift is waiting for feeders, not reflow from play". Điều này **sai cho knockout vòng 1** (18 trận, trung bình +30 phút, tối đa +180) và che mất A1. Nó cũng gọi mọi dòng `time-shifted` là reflow, trong khi trigger ghi cả các lần sửa tay.

---

## 7. Tổng hợp và đề xuất

### 7.1 Nên giữ nguyên

- Các ràng buộc cứng và bộ kiểm tra độc lập: 0 trùng lặp, 0 vi phạm thứ tự knockout.
- Tự sinh vòng 2 và nhánh đấu ngay khi có kết quả; không có nút bấm thủ công.
- `strictClose` cho tự xếp lịch (không tự ý đặt trận vượt giờ đóng).
- Reflow cho trường hợp phổ biến (chạy quá giờ trên cùng sân), giữ ngày 1 sát lịch.
- Mô hình `inProgressEnd` dùng chung cho planner, SQL và Desk; lý do sẵn sàng dùng chung cho tile và dialog.
- Nguyên tắc "đã công bố thì giữ" như **mặc định**. Chỉ cần thêm lối thoát khi mốc đã sai (P0-1).

### 7.2 Cần sửa trước khi dùng cho giải thật (P0)

| # | Đề xuất | Sửa ở đâu | Lợi ích | Trade-off |
| --- | --- | --- | --- | --- |
| **P0-1** | **Reflow xử lý trận đã quá giờ.** (a) Khi seed hàng đợi theo VĐV chung, đưa vào cả trận `scheduled` có `original_time ≤ now` (đã quá giờ). (b) Cho các trận *đã quá giờ và bị chặn* nhường chỗ: trận đủ điều kiện phía sau trên cùng sân được lên trước, còn trận bị chặn dời tới lúc VĐV rảnh + nghỉ. | `shift_live_schedule_core` (migration mới) | Sân 2 đã không đứng yên 98 phút. Giờ công bố phản ánh thực tế. | Đổi thứ tự trên sân nên VĐV phải được báo lại. Cần test: không lặp vô hạn, không vi phạm thứ tự trận tiên quyết. Thuộc vùng rủi ro cao, cần đủ bộ kiểm tra. |
| **P0-2** | **Trận bắt đầu khi chưa có giờ phải có giờ.** Ở `start_match_safe`, nếu `scheduled_time` hoặc `court_id` rỗng thì gán = thời điểm bắt đầu và sân đang dùng, trước khi chạy reflow. Trên Desk, pool "ready, unassigned" hiển thị "VĐV X đã có trận lúc HH:MM ở sân N" và hỏi xác nhận. | RPC bắt đầu trận; `desk.tsx` (`readyUnassigned`) | Đóng lỗ hổng gây ra A1. Thay đổi rất nhỏ. | Thêm một bước xác nhận khi có cam kết trùng. |
| **P0-3** | **Desk: khi trận đầu hàng bị chặn, đề xuất trận đủ điều kiện kế tiếp.** Tìm trước trên cùng sân, sau đó là trận của sân bận đang chờ, để chuyển sang sân trống. Ví dụ "WD A bị chặn (Dinh Giang ở sân 3) — WS A r1 s2 sẵn sàng: bắt đầu ở đây?" kèm hành động một chạm "Chuyển sang sân này & bắt đầu". | `deriveCourtState` và tile của Desk. Dùng lại `reschedulePlacementMatch`, vốn đã có trong dialog trận của Desk ("Check constraints and update"). | Giải quyết A1 và A6 từ phía vận hành, không cần chờ organizer Rebuild. | Không thêm quyền mới: moderator vốn đã dời sân và giờ được. Thay đổi là biến một thao tác ẩn, phải gõ tay, thành một gợi ý. Giới hạn gợi ý ở trận *đang sẵn sàng*, không lập lại cả lịch. |
| **P0-4** | **Cảnh báo sân bị kẹt ở mức Desk.** Tile hiện "Quá giờ N phút · bị chặn bởi …" khi trận đầu hàng trễ > 10 phút. Nếu > 20 phút, hiện gợi ý gửi organizer: "Đề nghị rebuild". | Tile Desk (moderator); thông báo nhỏ trên Schedule (organizer) | Không còn 98 phút im lặng. | Thêm tiếng ồn cho Desk. Cần ngưỡng hợp lý và không lặp lại cảnh báo đã thấy. |

### 7.3 Quan trọng (P1)

| # | Đề xuất | Lợi ích | Trade-off |
| --- | --- | --- | --- |
| **P1-4** | Ghi lý do bỏ qua của `place_ready_matches` và kết quả mỗi lần thử của reconciler (vào `desk_activity` hoặc log riêng). Tái hiện A3 bằng test tích hợp: 3 kết quả trong 7 giây, nhập từ trang Scores. Đảm bảo reconciler chạy ở mọi trang có thể nhập kết quả. | Giải thích và loại bỏ được việc "im lặng không xếp". | Log nhiều hơn. |
| **P1-5** | Khi thời điểm bắt đầu bị khoá bởi VĐV, chọn sân ít tải nhất hoặc trống lâu nhất thay vì sân số nhỏ nhất. | Giảm việc trận dồn vào sân 1–5 và chờ dây chuyền (A6). Sửa một dòng tie-break. | Trận phân tán trên nhiều sân hơn, nên VĐV có thể phải di chuyển xa hơn. |
| **P1-7** | Làm tròn giờ công bố về phút, và chỉ ghi khi giờ dời ≥ 2 phút (mô hình bên trong vẫn giữ độ chính xác cao). | Giảm ~60% nhiễu, bảng ổn định hơn, nhật ký sạch hơn. | Có thể lệch tối đa 2 phút giữa giờ công bố và mô hình. `schedule_conflicts` phải dùng cùng ngưỡng. |
| **P1-8** | "Will it fit?" dùng slot đã cấu hình, và thêm kiểm tra **theo ngày**: tổng phút sân, cận dưới chuỗi của VĐV có tải lớn nhất (số trận × (slot + nghỉ)), và cổng cả vòng. | Ngày 1 quá tải được báo từ lúc lập kế hoạch. | Vẫn chỉ là ước lượng. Cần diễn đạt rõ đây là lời khuyên. |
| **P1-9** | Sửa giờ hoặc sân bằng tay phải kiểm tra giờ đóng và trận tiên quyết, kèm lựa chọn tường minh "đánh vượt giờ (overrun)". | Tránh tình huống 17:01 và các lần thử rồi hoàn tác. | Thêm một dialog. |
| **P1-10** | Khi bắt đầu sớm hơn giờ công bố > 5 phút **và** việc đó lấy VĐV của một trận đang quá giờ hoặc sắp tới, cảnh báo "Trận X ở sân N sẽ trễ khoảng k phút". | Ngăn được bước leo thang thứ hai của A1 (lúc 12:44). | Thêm cảnh báo. |

### 7.4 Có thể tối ưu thêm (P2)

| # | Đề xuất | Lợi ích | Trade-off |
| --- | --- | --- | --- |
| P2-11 | Hiệu chỉnh slot theo thực tế. Gợi ý slot = trung vị quan sát + đổi trận, ví dụ 12 phút cho placement 1 game. Chỉ áp dụng khi có dữ liệu thật, vì dữ liệu mô phỏng không dùng được. | Ít dời giờ hơn. | Cửa sổ chứa được ít trận hơn. |
| P2-12 | Build ban đầu: ưu tiên khép vòng 1 của nội dung chậm nhất khi số lượng lẻ (MS r1-2 ở 15:49). Kiểm chứng bằng `strategy-replay` trên dataset này. | Có thể sớm khoảng 10–15 phút, và giảm tràn ngày. | Thay đổi thứ tự ưu tiên của solver; phải chạy lại benchmark. |
| P2-13 | Thời gian nghỉ theo số game vừa đánh (ví dụ +5 phút sau trận 3 game), hoặc giới hạn số trận mỗi ngày cho mỗi VĐV. | Công bằng và sức khoẻ cho VĐV nhiều nội dung. | Ít trận hơn trong cùng cửa sổ. |
| P2-14 | Cảnh báo khi bắt đầu một trận makeup có trận tiên quyết chưa xong (A8). | Đúng luật format. | — |
| P2-15 | Sửa README của snapshot: drift của knockout vòng 1; ý nghĩa của `time-shifted` (gồm cả sửa tay); "carried drift" 1146/1140 thực chất là ≈ 0 so với lúc build. | Phân tích sau này không bị dẫn sai. | — |
| P2-16 | Chạy thử lần 2 với thời lượng ngẫu nhiên theo phân phối thật, ít nhất 2 người vận hành trên 2 thiết bị, có nội dung số lượng chia hết cho 4, có walkover, sửa kết quả và rút lui, và có ngắt mạng. | Bao phủ các nhánh chưa từng chạy (§1.3). | Tốn công tổ chức. |

### 7.5 Đánh giá cuối cùng

| Tiêu chí | Đánh giá |
| --- | --- |
| **Tin cậy (đúng luật)** | **Tốt.** Không vi phạm ràng buộc cứng. Có 2 lỗ hổng nhỏ ở hàm kiểm tra khi bắt đầu trận (trận tiên quyết; rest tuỳ cấu hình). |
| **Hiệu quả (dùng sân, kết thúc sớm)** | **Ngày 1 tốt** (giới hạn là công suất). **Ngày 2 kém**: khoảng 80 phút có thể tiết kiệm (ước lượng), chủ yếu do A1, A3 và A6. |
| **Dễ vận hành** | **Tốt ở luồng chuẩn**, gần như không phải bấm gì. **Yếu khi lệch kế hoạch**: Desk không chỉ ra sân bị kẹt hay trận nên gọi thay, và cách gỡ duy nhất là Rebuild ở phía organizer. |
| **Trải nghiệm VĐV** | **Ngày 1 dễ đoán nhưng dày. Ngày 2 khó đoán** (knockout vòng 1 dời tới 3 giờ), chờ dài, và dồn trận về cuối ngày. |

**Khuyến nghị:**

- Sửa **P0-1 → P0-4**. Đây là các thay đổi nhỏ, khu trú ở reflow, RPC bắt đầu trận và tile của Desk.
- Điều tra **P1-4**.
- Sau đó chạy lại một giải thử theo P2-16, rồi mới dùng cho giải thật.

Nếu buộc phải dùng ngay, cần một người trực trang Schedule, theo dõi các sân "free-blocked" quá 10 phút, và sẵn sàng Rebuild. Tránh bắt đầu trận từ pool "ready, unassigned" khi VĐV của trận đó đã có giờ ở sân khác.

---

## 8. Cập nhật 2026-10-25: nguyên nhân gốc đã được xác định bằng cách chạy lại thuật toán

**Phương pháp.** Từ `tournament.json` và `desk-activity.csv`, trạng thái của giải được dựng lại tại từng thời điểm: trạng thái, sân và giờ công bố của mọi trận. Sau đó chính hàm `planPlacementSchedule({ mode: "place-ready" })` của ứng dụng được chạy trên trạng thái đó. Lần chạy lúc 12:23:24 cho ra **đúng 5 trận XD mà Desk đã ghi nhận**, khớp tới từng sân và từng phút. Như vậy phép chạy lại là thuật toán thật trên trạng thái thật **[Sự kiện]**. Ba thời điểm sáng ngày 2 hiện là test hồi quy (`src/lib/tournament/scheduling/viet-nam-open-replay.test.ts`).

### 8.1 Ba lỗi

| # | Lỗi | Bằng chứng | Hệ quả |
| --- | --- | --- | --- |
| L1 | **Bộ xếp lịch crash khi trận tiên quyết đã đánh ở ngày trước.** Trận makeup-2 tràn sang ngày 2 vẫn khai báo các trận vòng 2 của ngày 1 là trận phụ thuộc. Code chỉ đổi trận tiên quyết thuộc *vòng 1* thành mốc "không sớm hơn giờ X" (`stage-items.ts`). Bài toán của ngày 2 không chứa các trận ngày 1, nên phép kiểm tra đầu vào ném `unknown-dependency`. | Chạy lại lúc 12:12:35, 12:14:15 và 12:16:00 đều ném lỗi. Lúc 12:20 thì không, vì trận placement cuối cùng của ngày 2 đã bắt đầu lúc 12:19:32 nên bước xếp placement bị bỏ qua. | Mọi lần tự xếp lịch từ 12:12 tới 12:19 đều thất bại. 5 trận nhánh XD không có giờ trong 11 phút. |
| L2 | **Bộ xếp lịch và server nhìn sân khác nhau.** Ở chế độ place-ready, trận WD A (quá giờ, bị chặn vì Ly Van đang đánh) bị loại khỏi bài toán, nên bộ xếp lịch coi sân 2 là trống. Server vẫn tính sân 2 bị WD A chiếm. | Chạy lại lúc 12:30:52: bộ xếp lịch đặt MS A r1 s2 vào **sân 2 lúc 12:31**, chồng lên khung giờ WD A đang giữ. Server trả `court_busy`, và mỗi lần thử lại cho ra đúng kế hoạch đó. | MS A r1 s2 không bao giờ có giờ. Người vận hành tự bắt đầu nó lúc 12:31:46. Trường hợp này vô hại. |
| L3 | **Thất bại không để lại dấu vết.** `useAutoSchedule` nuốt lỗi. Bộ thử lại dừng sau 3 lần và chỉ thử tiếp khi danh sách trận chưa xếp thay đổi. | Từ 12:15 tới 12:23 không có lần thử nào, dù từ 12:19:32 việc xếp đã có thể thành công. | Trên Desk, các trận này trông như một danh sách "Ready to place" bình thường. |

### 8.2 Chuỗi nhân quả của sự cố sân 2 (A1), đã được chứng minh

1. 12:12:34: nhánh XD được tạo. Bộ xếp lịch crash (L1). Các trận XD nằm trong danh sách "Ready to place".
2. 12:14: người vận hành bắt đầu XD C r1 s1 từ danh sách đó, trên sân trống số 6. Ly Van bị kẹt trong trận này, trong khi đã có lịch WD A lúc 12:21 ở sân 2 (A2).
3. **Nếu không crash** thì sao? Chạy lại lúc 12:12:35 với L1 đã vá: XD C r1 s1 được xếp **lúc 12:52 ở sân 6**, sau trận WD A của Ly Van. Nó sẽ không nằm trong danh sách để bị bắt đầu lúc 12:14, và WD A sẽ đánh đúng 12:21 **[Sự kiện, theo phép chạy lại]**.
4. Phần còn lại diễn ra như A1: reflow không dời trận quá giờ, Desk chỉ cho thấy một trận mỗi sân, sân 2 đứng yên 99 phút.

Vì vậy nhận định ở §0, "một lần bắt đầu trận ngoài kế hoạch đã làm sân 2 đứng yên", là đúng, nhưng chưa đủ: **lần bắt đầu đó do lỗi của hệ thống mời gọi**. Người vận hành đã làm đúng điều Desk hiển thị.

### 8.3 Đính chính một số nhận định khác

- **A4 (MS bị tràn sang ngày 2).** Không hoàn toàn là giới hạn công suất. Chạy lại một lần rebuild toàn bộ lúc 16:04 ngày 1, vẫn giữ giờ đóng cửa 17:00, thì cả **3 trận MS vòng 2 vẫn nằm lại ngày 1**. Chế độ tự xếp từng trận (place-ready) giữ cố định mọi trận đã công bố, nên không tìm được chỗ. Đánh đổi là rebuild đó đổi giờ 14 trận. Còn nếu kéo dài giờ đóng cửa tới 17:30 và chỉ gỡ 5 trận bị tràn ra để xếp lại, thì cả 5 trận vào ngày 1 (trận cuối xong 17:21) mà **không trận nào khác đổi giờ**.
- **Rebuild toàn bộ để gỡ sân 2.** Chạy lại lúc 12:40, rebuild đổi giờ 10 trận, trong đó 6 trận bị kéo *sớm hơn* 32–59 phút. Nếu chỉ gỡ trận bị kẹt (WD A) ra rồi để tự xếp lại, chỉ 1 trận đổi giờ. Đây là cơ sở cho hướng "gỡ trận kẹt" của Đợt 3.

### 8.4 Đã sửa ở đâu

| Đợt | Nhánh | Nội dung |
| --- | --- | --- |
| 1 | `fix/scheduler-silent-failures` | Sửa L1 (`stage-items.ts`): mọi trận tiên quyết đã đánh xong đều thành mốc thời gian. Sửa L2 (`placement-schedule.ts`): trận bị loại khỏi bài toán vẫn giữ sân của nó. Sửa L3: báo lỗi trên Desk, và thử lại mỗi khi có trận bắt đầu hoặc kết thúc. Thêm test hồi quy chạy lại dữ liệu giải. "Will it fit?" dùng độ dài trận lấy từ setting. |
| 2 | `feat/desk-start-guard` | Đóng các đường bắt đầu trận ngoài lịch: sân trống không mời bắt đầu trận; trang Scores không còn nút Start; bỏ dời sân và giờ bằng tay; server từ chối trận chưa có giờ hoặc bị truyền sai sân. Không hiện "Ready" khi trận tiên quyết chưa xong (A8). |
| 3 (đang lập phạm vi) | — | Gỡ trận kẹt, thẻ quyết định cuối ngày, làm tròn giờ công bố (A1, A4, A5, A7). |
