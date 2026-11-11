# Rà soát repository Tournova trước public

## Những gì website đang thu thập và công khai

### Takeaway
Tournova hiện có open signup, dữ liệu liên hệ người chơi và luồng nhập người chơi tại bàn; tên/giới tính người đã vào giải công khai bằng RPC. Chưa thấy mô hình tuổi, người giám hộ hay chấp thuận pháp lý trong các bề mặt được rà soát. Đây là rà soát mã nguồn, không phải chứng nhận bảo mật hay kiểm tra production.

### Cited Findings
- Signup hiện gửi email/password tới Supabase, không kèm phiên bản Terms, timestamp chấp thuận hoặc tuổi/guardian; form có hai chế độ signup/signin. [Auth](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/auth.tsx:147).
- Trang nhập người chơi giữ name/email/phone/gender; các input email/phone/gender ở dòng 349–358. [Entries](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/tournaments/$tournamentId/entries.tsx:349).
- Đăng ký doubles thu partnerName và partnerEmail của người thứ ba, và yêu cầu cả hai khi chọn doubles. [Registration](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/tournaments/$tournamentId/index.tsx:400); [inputs](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/tournaments/$tournamentId/index.tsx:504).
- Schema players có email, gender, name, phone, profile link; profiles có email và auth link. [Types](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/integrations/supabase/types.ts:563); [Profiles](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/integrations/supabase/types.ts:811).
- Public tournament_players trả id/name/gender; grant cho anon và authenticated; cả withdrawn included. Global roster view bị revoke, global name search chỉ editor nhưng tìm trên toàn bộ roster chứ không chỉ giải của họ. [Migration](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/supabase/migrations/20261009000000_scoped_player_reads.sql:34); [Caller](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/lib/tournament/data.ts:1002).
- Tournaments hiển thị trên Explore ngay khi tạo; website có public players/schedule/brackets/results. [Architecture](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/information-architecture.md:16); [Explore](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/explore.tsx:467).
- Có xuất CSV kết quả dùng teamLabel/player name, score, event; WrapUp tạo Blob và download. [Export](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/lib/tournament/results-export.ts:65); [Download](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/components/tournament-setup/WrapUp.tsx:63).
- Contact đọc được bởi owner/editor của bất kỳ giải nào người chơi đã tham gia; documents ghi rõ đây là phạm vi tournament, không per-team. [Known debt](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/reference/authorization.md:703).

### Inferences
- Cần phân biệt người dùng tự mở account, người được bạn đánh doubles nhập hộ, và trẻ em do organizer nhập hộ. Một checkbox signup không bao phủ hai nhóm sau.
- Với xác nhận mới rằng cho phép dưới 18 tuổi và organizer nhập tên trẻ em, quyền công bố phải thành một quyết định rõ ở cấp người chơi/giải; tên công khai trên API có ý nghĩa dù UI có ẩn hay dùng noindex.
- Global player search cho editor giải khác là luồng chia sẻ ngoài giải cần cân nhắc thu hẹp hoặc giải thích, đặc biệt cho trẻ em.

### Gaps
- Không tìm thấy field tuổi/DOB/guardian/parental consent trong generated types; không thấy age gate trong auth. Chưa kiểm tra từng historical migration để chứng minh tuyệt đối không tồn tại implementation khác.
- Không thấy tính năng photo/avatar/upload file trong src qua tìm kiếm có mục tiêu; không suy ra là production không bao giờ thu ảnh qua kênh ngoài website.
- Không kiểm tra runtime traffic, logs, production settings, DPA/region/retention của Supabase/Cloudflare, hoặc quyền cụ thể đã deploy.

## Những thiếu hụt pháp lý và vận hành thấy trong mã

### Takeaway
Footer chủ ý bỏ Privacy/Terms/Support vì chưa có trang. Chưa thấy quy trình request dữ liệu, retention hay xóa/anonymize account hoàn chỉnh. Nhà cung cấp và browser storage cần được mô tả đúng trong policy.

### Cited Findings
- Footer chỉ có tên/copyright và Explore; comment nói rõ Privacy/Terms/support để trống tới khi có trang. [Footer](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/components/app-shell.tsx:307).
- Client Supabase persistSession true, autoRefreshToken true, dùng localStorage mặc định. [Client](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/integrations/supabase/client.ts:50).
- LocalStorage khác chứa view mode và người đang theo dõi trong trình duyệt; tournament setup dùng sessionStorage. [View](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/hooks/useViewMode.ts:26); [Follow](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/hooks/useMyPlayer.ts:29); [Draft](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/components/tournament-setup/local-draft.ts:12).
- Root gọi Google Fonts API/gstatic cho Instrument Sans/JetBrains Mono; đồng thời có WOFF2 font local Roboto Condensed/Saira. [Root](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/routes/__root.tsx:112); [Styles](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/src/styles.css:12).
- Xóa auth user là recovery seam: unlink profile và giữ relationships, không đồng nghĩa xóa dữ liệu cá nhân trong profiles/players/registrations. [Recovery](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/reference/authorization.md:655).
- Chỉ pending registration được withdraw; approved không có participant self-cancel. Withdrawal vẫn không loại tên khỏi public tournament_players. [Contract](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/reference/authorization.md:719); [RPC comment](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/supabase/migrations/20261009000000_scoped_player_reads.sql:54).
- Có script logical backup public schema; header có nhận định lịch sử về backups production, không coi đó là trạng thái hiện tại. [Backup script](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/scripts/backup-production.mjs:3).

### Inferences
- Cần privacy request workflow có xác minh chủ thể, sửa/xóa/anonymize có quan hệ nhiều giải, và chính sách backup; không dùng delete auth user làm implementation của privacy deletion.
- Chưa thấy analytics/ads SDK thường gặp trong dependencies hoặc source search; đây là căn cứ để giữ launch không ads/analytics, không phải cam kết rằng không có access logs/IP.
- Không thấy LICENSE/NOTICE qua repository file search (ngoài node_modules). Cần inventory OSS/font/image nguồn và giấy phép, không suy ra các dependency không có license.

### Gaps
- Chưa xác minh giấy phép cụ thể từng dependency/font, quyền logo Tournova, trademark clearance, ownership mã nguồn/asset.
- Không đọc .env, token, recordings, backups hoặc production data; không quét full security. Kiến trúc RLS/RPC có guard không bảo đảm không có lỗi.
- Không có browser accessibility audit trong nghiên cứu này; package có axe-core/playwright nhưng chưa chạy nên không đưa kết luận đạt WCAG.

## Thứ tự bổ sung và cách kiểm chứng

### Takeaway
Chốt chính sách trẻ em và dữ liệu công khai trước viết Terms/Privacy; sau đó triển khai guard server và luồng request; cuối cùng kiểm tra public release. Không sửa mã nguồn ứng dụng trong nhiệm vụ nghiên cứu này.

### Cited Findings
- Repository yêu cầu context trước vùng mới, đọc IA trước URL mới, roster-freeze trước thay đổi withdrawal khi có trận; security/authorization/RPC thay đổi cần full verify và integration local thực sự. [Root rules](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/AGENTS.md); [Authorization](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/authorization.md:47).
- Full gate: typecheck → contracts → full Vitest → strict hermetic Playwright zero skips → build; local integration bổ sung cho authorization/database. [Verification](/C:/Users/nhphuong/Desktop/badminton-ver-2/shuttle-scheduler/docs/verification.md).

### Inferences
1. Owner + luật sư chốt age bands/account eligibility, organizer nhập hộ trẻ em, cơ sở/quyền công bố tên/gender/results, quyền của guardian, và retention theo loại dữ liệu. Không tự giả định COPPA chắc chắn áp dụng hoặc organizer checkbox luôn đủ.
2. Lập data inventory và visibility matrix: contact private, ai đọc roster/search, public/export/indexing, nhà cung cấp/logs/backups; chốt giữ hoặc thu hẹp cross-tournament search.
3. Thêm routes Terms/Privacy/Contact + thông báo tại signup/registration/import; lưu version/time của assent Terms. Privacy notice acknowledgement tách khỏi optional publicity consent/marketing.
4. Xây minor/guardian handling và public-visibility ở DB/RPC, kể cả direct API, Realtime, CSV, withdrawn, doubles partner và tên nhập tại Desk; UI phải giải thích ai được thấy.
5. Privacy inbox + verified correction/access/delete/anonymize request process, retention job và backup expiry, incident runbook. Có thể manual ban đầu nếu thực hiện được, có owner và thời hạn rõ.
6. Accessibility thực tế keyboard/screen reader/zoom/error/contrast; asset/license inventory; security review RLS/auth/email config/rate limit và provider contracts/settings; dry-run bằng dữ liệu giả.
7. Khi implementation đóng phase: chạy agent:verify, local safe integration nếu DB/RPC/auth, không coi mock browser là chứng minh policy; rồi lawyer review nội dung và public release checklist.

### Gaps
- Thời lượng implementation phụ thuộc quyết định hỗ trợ dưới13 tuổi, dữ liệu công khai và retention; không đủ căn cứ estimate chính xác trong rà soát này.
- Working tree ban đầu có src/routeTree.gen.ts modified và nhiều untracked agent/Impeccable/PRODUCT.md; đã giữ nguyên, không chạy tests vì chỉ ghi ghi chú nghiên cứu.
