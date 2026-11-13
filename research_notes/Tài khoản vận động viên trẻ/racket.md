# Nền tảng giải đấu vợt và tài khoản trẻ

Nghiên cứu ngày 13/11/2026. Chỉ dùng trang chính thức công khai; không tạo tài khoản, không gửi thông tin trẻ, không kiểm chứng backend. Phân biệt mô tả của hãng với quan sát giao diện đăng ký.

## Tournamentsoftware có bắt buộc 18+ không?

### Takeaway
Không. Form đăng ký công khai của Tournamentsoftware cho phép người từ 16 tuổi tự xác nhận, hoặc phụ huynh/người giám hộ trực tiếp tuyên bố cho phép xử lý dữ liệu để tạo tài khoản cho con. Đây không phải câu “tôi dưới 18 và bố mẹ đã cho phép” do trẻ tự xác nhận.

### Cited Findings
- Trang signup có họ tên, sport, login name, email gửi confirmation link, mật khẩu. Câu xác nhận dùng hai tư cách: người đăng ký đã đủ 16, hoặc chính phụ huynh/người giám hộ đồng ý xử lý dữ liệu con để tạo account; có lựa chọn Yes/No. Không thấy bước tài khoản phụ huynh riêng hay xác minh danh tính phụ huynh trong nội dung form được trích xuất. — [Signup trực tiếp](https://www.tournamentsoftware.com/User/Signup)
- Bằng chứng liên hệ với cầu lông: Badminton Alberta hướng dẫn phụ huynh nhập giải junior qua Tournamentsoftware, kiểm tra thông tin đúng là của người chơi; nhiều con cần username/password riêng cho mỗi con. Hướng dẫn này xuất bản 15/11/2017, vẫn công khai nhưng phải coi là bằng chứng lịch sử, không xác nhận mọi luồng hiện tại. — [Parents Guide của Badminton Alberta](https://www.badmintonalberta.ca/news/116509/Parents-Guide-How-to-enter-Badminton-Alberta-sanctioned-tournaments)

### Inferences
- Họ tách tư cách người thực hiện signup khỏi người chơi. Có thể học câu “Tôi là phụ huynh/người giám hộ và đồng ý…” thay vì coi lời xác nhận của trẻ là hành động đồng ý trực tiếp của phụ huynh.
- Form chứng minh có tuyên bố consent, không chứng minh verified parental consent.

### Gaps
- Không đọc được signup tại subdomain BWF qua web tool; không suy ra BWF có flow giống hệt.
- Không tìm thấy bằng chứng công khai đủ mạnh về email approval riêng từ phụ huynh, audit trail hoặc guardian dashboard của Tournamentsoftware. Không có ngày cập nhật trên signup.

## UTR Sports xử lý trẻ và thanh thiếu niên ra sao?

### Takeaway
UTR không giới hạn toàn bộ dịch vụ ở người lớn. Terms chung có cơ chế người chưa đủ tuổi ký hợp đồng nhận permission và để phụ huynh đồng ý Terms thay mình; hỗ trợ công khai còn mô tả tạo account riêng cho từng trẻ, với email phụ huynh. Các tài liệu của họ không hoàn toàn đồng nhất về dưới 13.

### Cited Findings
- Terms cập nhật 16/6/2026: người chưa đủ tuổi giao kết phải được parent/guardian cho phép và để người đó đồng ý Terms thay; signup yêu cầu DOB. Phần Privacy chung bảo dưới 13 đừng tự đăng ký/gửi dữ liệu, nhưng phần Event Services có quy trình consent có thể kiểm chứng cho dữ liệu dưới 13 và giới hạn việc dùng dữ liệu cần thiết trước consent. Không mô tả phương thức xác minh cụ thể. — [Terms](https://www.utrsports.net/policies/terms-of-service)
- Help hướng dẫn mỗi trẻ có account và unique email riêng, điền DOB của trẻ; nếu DOB thể hiện trẻ 13 tuổi hoặc nhỏ hơn thì web signup hiện ô email phụ huynh, để phụ huynh nhận bản sao email account. Không được suy diễn việc gửi bản sao email là cha mẹ đã approve. — [How do I set my child up with an account?](https://support.universaltennis.com/en/support/solutions/articles/9000151971)
- Privacy nói không cố ý thu thập dữ liệu trực tiếp từ dưới 13, hoặc người EU/UK dưới 16; đồng thời nói một số nội dung profile có thể công khai cho người chưa đăng nhập và được search engine tìm thấy. Đây là policy chung, không đủ chứng minh mặc định hiển thị của từng nhóm tuổi. — [Privacy](https://www.utrsports.net/policies/privacy-policy)

### Inferences
- Với 13–17, điều kiện Terms gần với hướng Tournova đang làm, nhưng UTR có thêm DOB và email phụ huynh được mô tả trong help.
- Không nên trích riêng dòng “under13 not allowed” rồi kết luận họ không có trẻ dưới13; Event Services và hướng dẫn gia đình cho thấy cần tách self-signup, người nhập hộ và xử lý dữ liệu giải đấu.

### Gaps
- Không có bằng chứng đủ để nói ô email phụ huynh trong help là approval link, verified consent, hoặc teen guardian check áp dụng cho tất cả độ tuổi.
- Help không hiện ngày cập nhật rõ trong bản đọc; Terms và Privacy/help có căng thẳng về under13, nên cần xác nhận với UTR trước khi sao chép nguyên ngưỡng/quy trình.

## Pickleball.com có luồng phụ huynh thật sự không?

### Takeaway
Có mô tả sản phẩm cụ thể hơn checkbox: tài khoản phụ huynh liên kết với tài khoản trẻ, parent nhận email invitation, đăng nhập bằng account của mình, ký và chấp thuận, sau đó quản lý registrations/privacy/notifications. Tuy nhiên các ngưỡng 13, 15, 17 trong tài liệu chính thức không đồng nhất.

### Cited Findings
- Hướng dẫn support nói mọi account dưới 17 phải gắn parent/guardian; tạo từ account phụ huynh, nhập thông tin trẻ, parent ký consent/media release bằng họ tên, trẻ xác minh email bằng mã sáu số. Có danh sách Accounts I Manage; parent có thể thao tác như trẻ mà không chuyển ownership. Có thể chọn hiển thị họ của trẻ hay không. Tài liệu hiện “Modified on Wed, Mar 25”, không hiện năm ở dòng ngày; không suy ra năm. LƯU Ý: bài này diễn giải COPPA thành dưới18; đó là phát biểu của hãng, không được sử dụng làm nguồn pháp luật. — [Help chính thức](https://pickleball.freshdesk.com/en/support/solutions/articles/72000649335-how-to-connect-and-manage-existing-minor-accounts)
- Với account trẻ đã tồn tại, bài 9/12/2025 mô tả: trẻ gửi invitation; phụ huynh đăng nhập account riêng từ email, xem parental consent/media waiver, nhập họ, tick xác nhận, Accept. Parent quản lý đăng ký, notifications và privacy toggles như media release/contact visibility/information sharing. Đây là mô tả chính thức, chưa tự chạy flow. — [Phase Two](https://pickleball.com/blogs/phase-two-how-to-connect-and-manage-existing-minor-accounts-1)
- Trang policy chung áp dụng cả Pickleball Brackets: dưới15 muốn lập account cần parent consent bằng một giao dịch thẻ tín dụng nhỏ từ thẻ của phụ huynh, account sau đó supervised; parent có thể sửa/xóa dữ liệu hoặc rút consent. Cũng trang này, Terms nói dưới13 không được tự tạo account. Ngưỡng dưới15 và cơ chế thẻ không khớp hoàn toàn với help dưới17 và luồng email/signature; không có bằng chứng công khai đủ để biết tất cả có cùng chạy hay policy bị cũ. — [Privacy + Terms](https://pickleball.com/privacy-terms-dmca)

### Inferences
- Benchmark hữu ích là liên kết guardian thật và hành động đồng ý từ phía guardian, kèm lựa chọn hiển thị dữ liệu. Chỉ checkbox của teen hiện tại của Tournova chưa tương đương cơ chế này.
- Không thể lấy policy đối thủ làm chứng nhận tuân thủ pháp luật; chính tài liệu của họ có chỗ không thống nhất. Không nên gộp consent tạo account, consent tham gia giải và media release thành một loại permission mặc định.

### Gaps
- Chưa xác nhận giao dịch thẻ tín dụng nhỏ còn thực sự nằm trong flow hiện tại; chưa kiểm tra backend/audit hoặc quyền withdrawal ngoài mô tả policy.
- Không thể kết luận dưới13 được tự mở tài khoản: có thể là hồ sơ do người lớn tạo, trong khi Terms cấm chính trẻ tự tạo.
