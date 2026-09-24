# PR bên cạnh branch

Header terminal đủ rộng có link riêng `PR #123 · Draft / Open / Merged / Closed`, giữ nguyên màu
branch. Nhãn PR và thông tin branch cùng ẩn khi hover để chỉ hiện các nút điều khiển. Header hẹp dùng nhãn gọn `#123 · Draft`, ưu tiên chỗ cho trạng thái PR trước tên branch.
Chỉ header rất nhỏ (dưới 360 logical pixel ở cỡ chữ bình thường) mới ẩn nhãn.
Click mở GitHub; không merge, checkout hay xoá worktree.

CLI đọc branch và remote `origin` tại thư mục của agent, kể cả linked worktree, rồi dùng `gh` và
phiên đăng nhập GitHub trên máy đó. Đây là truy vấn chỉ đọc, có timeout, không tự mở login. Request
và response được mã hoá khi chuyển tới máy remote.

Chỉ hiện nhãn khi có kết quả PR hợp lệ. Đang tải, không có PR hoặc không tra cứu được đều ẩn nhãn.
API vẫn phân biệt lỗi tra cứu với tra cứu thành công nhưng không có PR. Refresh mỗi phút, cache CLI 60 giây có giới
hạn, bỏ kết quả cũ khi đổi agent/branch. Ưu tiên PR đang mở; nếu không có, lấy PR cập nhật gần nhất.

Phạm vi ban đầu: repo github.com trong `origin`, khớp cả branch lẫn repository nguồn. Chưa tìm PR từ
fork sang upstream hay GitHub Enterprise. Đã merge không có nghĩa worktree sạch hoặc có thể xoá.
