# PR bên cạnh branch

Header terminal đủ rộng có link riêng `PR #123 · Draft / Open / Merged / Closed`, giữ nguyên màu
branch. Link vẫn click được khi hover hiện các nút điều khiển. Header hẹp ẩn nhãn để tránh chật.
Click mở GitHub; không merge, checkout hay xoá worktree.

CLI đọc branch và remote `origin` tại thư mục của agent, kể cả linked worktree, rồi dùng `gh` và
phiên đăng nhập GitHub trên máy đó. Đây là truy vấn chỉ đọc, có timeout, không tự mở login. Request
và response được mã hoá khi chuyển tới máy remote.

Tra cứu thành công và không có PR thì ẩn nhãn. Thiếu hỗ trợ CLI, gh, đăng nhập, mạng hoặc quyền repo
thì hiện `PR unavailable`; không được coi là chưa có PR. Refresh mỗi phút, cache CLI 60 giây có giới
hạn, bỏ kết quả cũ khi đổi agent/branch. Ưu tiên PR đang mở; nếu không có, lấy PR cập nhật gần nhất.

Phạm vi ban đầu: repo github.com trong `origin`, khớp cả branch lẫn repository nguồn. Chưa tìm PR từ
fork sang upstream hay GitHub Enterprise. Đã merge không có nghĩa worktree sạch hoặc có thể xoá.
