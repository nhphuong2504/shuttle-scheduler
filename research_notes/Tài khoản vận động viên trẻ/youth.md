# Nền tảng đăng ký thể thao trẻ em

Nghiên cứu ngày 13/11/2026. Phạm vi là Terms, Privacy và hướng dẫn chính thức công khai; không tạo tài khoản và không kiểm thử luồng đăng ký đăng nhập thực tế. Các mô tả thao tác dưới đây là tính năng được tài liệu nhà cung cấp mô tả, không phải khẳng định đã quan sát UI trực tiếp.

## LeagueApps xử lý tài khoản phụ huynh và tài khoản teen thế nào?

### Takeaway

LeagueApps phân biệt tài khoản người lớn, hồ sơ trẻ trong gia đình và quyền truy cập app của teen. Luồng được tài liệu mô tả có hành động từ tài khoản phụ huynh, tiếp theo là lời mời để teen tạo tài khoản; không chỉ là teen tự tick rằng phụ huynh đã đồng ý.

### Cited Findings

- General Terms: Standard Member Account yêu cầu 18+. Youth Registrants được mô tả là 13–18 và phải được cả đơn vị tổ chức lẫn một phụ huynh cho phép. Chỉ phụ huynh được cấp phép tạo youth account; cùng trang có câu “older than thirteen”, nên wording ngưỡng chính xác 13 chưa nhất quán. “Site” ở đây được định nghĩa là website marketing leagueapps.com, không nên diễn giải thành cấm mọi trang web giải đấu. — [LeagueApps Terms](https://leagueapps.com/terms/).
- Youth Terms, cập nhật 17/9/2024: nhóm 13–18 có thể dùng youth app services khi được coach/league và parent cho phép; dưới 13 không được trực tiếp dùng các dịch vụ này. Khi mở youth account, họ yêu cầu phụ huynh cung cấp tên và email của teen. — [Youth Registrant Terms](https://leagueapps.com/youth_athlete_terms/).
- Hướng dẫn đăng ký trẻ em, ngày 8/10/2019 và vẫn công khai: người dùng tạo tài khoản cho chính phụ huynh/supervisor trước; sau đó thêm hoặc chọn từng trẻ; một tài khoản có thể quản lý nhiều trẻ. Email của trẻ là tùy chọn, có thể bỏ qua. Phụ huynh chấp nhận waivers/e-signatures trong đăng ký. — [How to register your children for a program](https://support.leagueapps.com/hc/en-us/articles/360036472274-How-to-register-your-children-for-a-program).
- Hướng dẫn youth app, ngày 20/9/2024: admin bật youth access và chọn Athlete Age; phụ huynh vào dashboard/app để cấp quyền, chọn quyền chat, chấp nhận điều khoản rồi lưu. Teen được gửi email/lời mời hoặc nhận link từ phụ huynh và tự chấp nhận Terms khi mở tài khoản. Có trạng thái Pending, Joined, Not Eligible. Phụ huynh được đưa vào chat của U18 và có thể xem/xóa nội dung của con. — [Athlete Mobile App Access](https://support.leagueapps.com/hc/en-us/articles/26512343802519-Athlete-Mobile-App-Access).

### Inferences

- Tournova có thể học mô hình parent profile/account → child participant profile → youth access permission → invitation → own youth login. Cần lưu người thực hiện sự cho phép, phiên bản Terms, thời điểm và trạng thái thu hồi quyền, thay vì chỉ lưu bool do teen gửi.
- Parent invitation và quyền được gắn với hồ sơ là bằng chứng thao tác tốt hơn self-attestation đơn lẻ; tài liệu trên không chứng minh họ xác minh quan hệ phụ huynh theo một phương pháp COPPA cụ thể.

### Gaps

- Các tài liệu dùng cả “between thirteen and eighteen” và “older than thirteen”; không đủ cơ sở chốt mọi cấu hình cho phép người vừa tròn 13. Help cho phép admin chọn age setting.
- Không tìm thấy mô tả phương pháp kiểm tra danh tính/quan hệ pháp lý của phụ huynh; không khẳng định invitation/email là verifiable parental consent.
- Không nên bê nguyên tuyên bố SafeSport compliance của nhà cung cấp thành đánh giá độc lập hoặc thành yêu cầu pháp lý áp dụng cho Tournova.

## TeamSnap có đồng nhất tuổi người đăng ký và tuổi người chơi không?

### Takeaway

Không. TeamSnap ONE yêu cầu người hoàn thành registration là người lớn nhưng participant có thể là trẻ; tài khoản, participant và các contact được tách riêng. Đó là ví dụ rất trực tiếp rằng có thể phục vụ giải trẻ em trong khi người lớn chịu trách nhiệm đăng ký.

### Cited Findings

- Hướng dẫn TeamSnap ONE cập nhật 1/10/2026: phải từ 18 tuổi để hoàn tất registration. Sau đăng nhập, chọn participant đã liên kết hoặc thêm participant mới với tên, giới tính, ngày sinh; player contact phải từ 13 tuổi. Các waiver là bước có thể được tổ chức yêu cầu. — [Registration Guide for Prospective Members](https://teams-help.teamsnap.com/article/3001-registration-guide-for-prospective-members).
- Privacy Policy cập nhật 14/11/2025: dịch vụ không hướng tới dưới 13; user không được dưới 13 và phải đủ tuổi chấp nhận Terms/mở account. Dữ liệu player dưới 13 có thể được parent hoặc đại diện tổ chức cung cấp với consent phù hợp; không đồng nghĩa mọi user 13+ đều tự động đủ điều kiện hợp đồng. — [TeamSnap Privacy](https://www.teamsnap.com/privacy-policy).
- Hướng dẫn join cập nhật 29/9/2026: parent có TeamSnap ONE account, dùng invite code/link do coach cung cấp, chọn con trên roster và nhập DOB để liên kết contact. Parent đầu tiên là primary contact; parent tiếp theo là secondary. — [Join and Connect with Your Player’s Team](https://teams-help.teamsnap.com/article/3004-how-to-join-and-connect-with-your-player-s-team-in-teamsnap-one).
- Hướng dẫn contacts cập nhật 29/9/2026: primary contact có thể thêm contact khác, phân quyền primary/non-primary và gửi email invitation. Nếu email đã có TeamSnap account thì contact được thêm tự động; contact mới được cấp quyền đối với mọi team của player. — [Adding or Removing Contacts for Players](https://teams-help.teamsnap.com/article/2965-adding-or-removing-contacts-for-players).

### Inferences

- Tournova nên tách ba việc: ai ký/submit entry, ai là vận động viên, ai nhận liên lạc. Parent đăng ký cho con không nên làm parent bị nhận nhầm là player và không tự tạo quyền vận hành giải.
- Cơ chế invite + DOB match mô tả cách liên kết roster và tài khoản; không đủ để kết luận đây là kiểm chứng danh tính phụ huynh hay VPC.

### Gaps

- Không có bằng chứng trong các trang đã đọc cho phép mọi teen tự hoàn tất registration; tài liệu ONE nói rõ người đăng ký phải 18+.
- Không kiểm thử production UI và không xác định mỗi khách hàng dùng ONE hay legacy. Không gộp các luồng legacy và ONE thành một.

## SportsEngine dùng household và guardian ra sao, và bài học giới hạn là gì?

### Takeaway

SportsEngine mô tả child sub-profile thuộc Household và guardian riêng có email/account, với invitation được chấp nhận trước khi có quyền. Tài liệu Terms đang được index ghi eligibility 18+ cho US, nhưng các trang trực tiếp trả 403 cho công cụ fetch; cần giữ rõ giới hạn bằng chứng này.

### Cited Findings

- Terms of Use mục 1.3.1 trong kết quả chính thức được index: US users phải 18+; Canada dùng tuổi thành niên theo tỉnh/lãnh thổ. Đây là điều kiện tài khoản/dịch vụ, không phải tuổi tối thiểu của athlete được đăng ký. Full fetch trả 403, nên chỉ xác nhận được nội dung index chính thức. — [SportsEngine Terms](https://www.sportsengine.com/solutions/terms-of-use/).
- Official help index, 4/3/2025: Household → Add Person → Child tạo hồ sơ trẻ bằng tên, giới tính, birthday và graduation year tùy chọn. Add Adult dùng email riêng, chọn athlete profile/quyền, rồi Send Invite; người đã có account nhận invite, người mới được yêu cầu tạo account. Full fetch 403. — [Add a Person in MySE](https://help.sportsengine.com/en/articles/10509528-add-a-person-in-myse).
- Official help index, 6/8/2026: athlete sub-profile → Permissions → Add guardian email và access level → Send Invite. Guardian giữ trạng thái Pending đến khi chấp nhận trong dashboard; người mời nhận email khi đã chấp nhận. Full fetch 403. — [How to Add Guardians](https://help.sportsengine.com/en/articles/6304039-how-to-add-guardians).
- Official mobile help index, 6/8/2026: chỉ guardian đã opt in chia sẻ contact mới có thể được người khác liên hệ qua roster. Đây là kiểm soát chia sẻ contact, không phải chứng cứ mọi dữ liệu player đều private. — [Contact the Guardian of an Athlete](https://mobile-help.sportsengine.com/en/articles/8365218-how-to-text-call-or-email-the-guardian-of-an-athlete).
- FTC FAQ phân biệt COPPA bảo vệ trẻ dưới 13 với teen, và trong A.8 nói COPPA không áp dụng chỉ vì thông tin về trẻ được thu trực tuyến từ chính phụ huynh/người lớn. Phạm vi thực tế vẫn phụ thuộc việc ai cung cấp dữ liệu, tracking và đối tượng dịch vụ. FAQ tự nhắc quy tắc được sửa 22/4/2025, cần đọc rule hiện hành cho yêu cầu chi tiết. — [FTC COPPA FAQ, A.8–A.9](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions).

### Inferences

- Pattern phù hợp cho Tournova là account người lớn quản lý child participant mà trẻ không phải tự gửi email/tạo login; các guardian khác được liên kết có quyền cụ thể, trạng thái mời và có thể thu hồi. Teen login có thể bổ sung sau theo pattern LeagueApps.
- Không thể suy ra Tournova tuân thủ COPPA chỉ từ ngưỡng 13, checkbox, email hay việc gọi dữ liệu là parent-managed. Các nguồn trên cho thấy pattern sản phẩm, không cung cấp legal clearance cho app khác.
- Việc hiện tại Tournova có checkbox do teen tự khai phù hợp với yêu cầu policy ở mức khai báo, nhưng chưa tương đương luồng phụ huynh có account và chủ động cấp quyền mà LeagueApps công bố.

### Gaps

- SportsEngine full pages trả 403 nên không xác minh được toàn trang, ngày cập nhật Terms hoặc mối quan hệ giữa tài liệu cũ 13+ lưu trên CDN với Terms mới; không dùng các PDF cũ của câu lạc bộ làm chuẩn policy hiện hành.
- Không có bằng chứng từ các tài liệu này cho biết email invitation là phương pháp COPPA VPC. Không đánh đồng kiểm tra email, DOB hoặc account login với xác minh legal guardianship.
