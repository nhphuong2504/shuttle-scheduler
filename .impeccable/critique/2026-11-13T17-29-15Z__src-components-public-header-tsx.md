---
target: Toàn bộ hiệu ứng header Tournova, ưu tiên hiện đại
total_score: 27
max_score: 36
na_heuristics: 10
p0_count: 0
p1_count: 0
target_identity: "file:C:\\Users\\nhphuong\\Desktop\\badminton-ver-2\\shuttle-scheduler\\src\\components\\public-header.tsx"
target_fingerprint: "sha256:91f2765416533a7fa8471f93800dada2b2acba1190bc38090b8771716e353205"
target_path: "C:\\Users\\nhphuong\\Desktop\\badminton-ver-2\\shuttle-scheduler\\src\\components\\public-header.tsx"
timestamp: 2026-11-13T17-29-15Z
slug: src-components-public-header-tsx
---
Method: dual-agent (A: header_design_review · B: header_evidence)

Mình đề xuất header hiện đại, gọn và ổn định: nền hover nhẹ, trạng thái đang mở rõ ràng, menu chuyển động ngắn và nhất quán.

Header hiện tại hợp với một console giải đấu: màu trung tính, thương hiệu rõ, vị trí không nhảy. Cảm giác chưa hoàn thiện đến từ cách các thành phần phản hồi khác nhau. Đây là vấn đề thống nhất tương tác hơn là thiếu hiệu ứng.

## Nguồn nghiên cứu

- Linear, UI refresh ngày 12/3/2026: làm nhất quán headers/navigation/view controls và giảm độ nổi của navigation để nội dung chính được ưu tiên. https://linear.app/changelog/2026-03-12-ui-refresh
- Vercel Geist Materials: chọn mức nổi thấp nhất vẫn giúp phân biệt bề mặt. https://vercel.com/geist/materials
- Vercel Geist Menu: menu mở bằng click, hỗ trợ Escape, ngoài vùng và trả focus. https://vercel.com/geist/menu
- W3C: người dùng cần kiểm soát các chuyển động không thiết yếu. https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html

Các thời gian chuyển động dưới đây là đề xuất cho Tournova, không phải thông số đo từ Linear hoặc Vercel.

## Hai vấn đề ưu tiên

1. P2 — Chưa tách rõ hover, focus và active. Public hover đã không có gạch chân, nhưng keyboard focus vừa có outline vừa có underline, còn active cũng dùng underline. Source của New tournament trong workspace còn hover:underline. Sửa bằng cùng một nền hover trung tính, active có nền và độ đậm riêng, focus chỉ dùng outline rõ. Suggested command: /impeccable polish.
2. P2 — Nhịp mở menu chưa đồng bộ. Account/switcher có mũi tên xoay trong khi panel xuất hiện tức thì; notification dùng fade kèm zoom. Sửa bằng một quy tắc chuyển động ngắn cho panel và mũi tên, giữ đúng kiểu disclosure/dialog và hành vi bàn phím. Suggested command: /impeccable animate, sau đó /impeccable polish.

## Đề xuất cụ thể

| Thành phần | Cách thể hiện đề xuất | Thời gian đề xuất |
|---|---|---|
| Hover | Nền trung tính rất nhẹ, chữ đậm màu hơn; không gạch chân hoặc nhấc item | 120–150ms |
| Trang đang mở | Nền nhẹ ổn định và chữ semibold; khác hover | Không cần chuyển động liên tục |
| Focus bàn phím | Một vòng focus rõ, bỏ underline bổ sung | Tức thì |
| Cuộn | Giữ chiều cao và vị trí; chỉ một đường phân cách/bóng rất nhẹ để nhận biết nội dung phía dưới | 150–180ms |
| Menu tài khoản/switcher | Fade và dịch tối đa 4px, mũi tên cùng nhịp; panel đóng nhanh hơn mở | Mở 140ms, đóng 100ms |
| Thông báo | Giữ semantics dialog hiện có, dùng fade nhẹ đồng bộ thay zoom | 140ms |
| Chạm và giảm chuyển động | Phản hồi nền khi chạm; giảm chuyển động bỏ dịch chuyển và xoay không cần thiết | Trạng thái trực tiếp |

Giữ logo ổn định. Bổ sung chuyển động chỉ để xác nhận thao tác; ưu tiên sự nhất quán giữa landing, public và workspace.

## Điểm tốt

- Header public giữ nguyên chiều cao khi cuộn; không có co giãn làm nội dung nhảy.
- Vùng bấm public 44px và focus rõ; reduced-motion có hiệu lực.
- Escape đóng account menu và trả focus về trigger được kiểm tra trực tiếp.

## Nielsen — phạm vi header

| Tiêu chí | Điểm | Nhận xét |
|---|---:|---|
| Trạng thái hệ thống | 3 | Focus và active còn dùng cue giống nhau |
| Ngôn ngữ quen thuộc | 4 | Tên mục và icon dễ hiểu |
| Quyền kiểm soát | 3 | Escape/ngoài vùng, trả focus |
| Nhất quán | 2 | Nhiều quy tắc trạng thái và nhịp menu |
| Ngăn lỗi | 3 | Vùng bấm và bố cục ổn định |
| Nhận biết | 3 | Nhãn rõ, thương hiệu mobile chưa đồng nhất |
| Hiệu suất thao tác | 3 | Menu và điều hướng bàn phím có nền tảng tốt |
| Tối giản thị giác | 3 | Ít nhiễu, focus còn trang trí trùng |
| Khôi phục lỗi | 3 | Retry thông báo và phản hồi lỗi có trong source |
| Trợ giúp | n/a | Ngoài phạm vi header |
| Tổng | 27/36 | Tốt; một số trạng thái signed-in được xem qua source |

## Persona, tải nhận thức và quan sát phụ

Người dùng bàn phím cần focus khác với trang đang mở. Người dùng điện thoại cần thương hiệu và cách chạm nhất quán. Người vận hành giải cần menu phản hồi nhanh, không kéo chú ý khỏi trận đấu. Public navigation có tải nhận thức thấp; workspace nhiều lựa chọn nhưng có nhóm và overflow cues, chưa cần mở rộng sang redesign IA.

Landing mobile giữ wordmark trong khi public mobile chỉ giữ mark. Đây là quan sát phụ về tính liên tục của thương hiệu, không phải lý do thay đổi toàn bộ header.

## Bằng chứng và giới hạn

Assessment A xem live public desktop/mobile 1440, 390, 320px và source của các thành phần. Assessment B kiểm tra public/landing/workspace desktop 1366×768 với fixture hermetic. Native CUA không khởi tạo được do Windows sandbox 1385; hai lượt dùng browser context Playwright riêng, chặn transport ngoài dự kiến. Không có source ứng dụng được sửa trong lượt review.

CLI detector chạy riêng public-header.tsx, app-shell.tsx, landing/landing.tsx: 0 findings. Live detector trả landing 2, explore 1, workspace 1: bounce/striped hero artwork nằm ngoài header; cảnh báo Instrument Sans là preference chung, không phải lỗi header. Không có finding riêng header. Mutable preflight và injection thành công; browser đã đóng, không có overlay còn mở cho người dùng. Helper đã dừng với --keep-inject.

Questions skipped: 2 priority issues; người dùng đã xác định ưu tiên phong cách hiện đại và yêu cầu nghiên cứu, đề xuất trước khi sửa thêm.
