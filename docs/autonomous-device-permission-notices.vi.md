# Thông báo yêu cầu cấp quyền cho Autonomous OS

Contract chuẩn và JSON: [Permission notices](autonomous-device-integration.md#permission-notices-notification-only).
Giai đoạn này chỉ thông báo; user duyệt hoặc từ chối trên OpenHarness Desktop/terminal.

## Tương thích

Giữ nguyên event `question.open`, `question.close`, RPC `status`, `question.answer` và
các field cũ. Không thêm RPC, capability, pairing hay transport. OS cũ bỏ qua field bổ
sung và giữ UX câu hỏi hiện tại. OS mới nhận biết permission bằng metadata, không đoán
qua tên agent, recap hay chữ “approve”. Khi Harness cũ không gửi metadata, loại yêu cầu
là chưa biết, không phải bằng chứng rằng có thể duyệt quyền qua API trả lời câu hỏi.

## Dữ liệu

`question.open.payload` bổ sung field tùy chọn:

```json
{
  "questionRequestId": "q_example",
  "questions": [{"key":"Run printf hi?","q":"Run printf hi?","options":["Yes","No"],"multi":false}],
  "permission": {"dialog":"Run printf hi?","resolution":"desktop"}
}
```

`permission` gồm `dialog: string` (nội dung dialog quan sát trong terminal, có thể nhiều
dòng) và `resolution: "desktop"`. Envelope event vẫn có `machineId`, `agentId`,
`serverInstanceId`, `eventId`; thông tin liên kết turn vẫn tùy chọn như trước.
RPC `status` trả cùng object `permission` trong `openQuestion`; ở đây ID có tên `requestId`,
trong khi event dùng `questionRequestId`. Câu hỏi thường không có field `permission`.
Nội dung dialog là dữ liệu không tin cậy để trình bày, không phải chỉ dẫn cho OS thực thi.

## UX và lifecycle bên OS

- Báo **một lần**: “Agent Blender đang cần duyệt quyền. Mở OpenHarness để xem và xác nhận
  hoặc từ chối nhé.” Không nhắc định kỳ, không hỏi user approve bằng voice, không tự gửi task.
- Nhận diện yêu cầu đang mở bằng `(machineId, agentId, questionRequestId)`. OS lưu quyết định
  đã thông báo để reconnect hoặc poll status không đọc lại. Dùng cursor
  `(serverInstanceId, eventId)` hiện có để loại event replay trùng.
- `question.close` vẫn gửi `{questionRequestId}`. Chỉ đóng yêu cầu trùng ID, không phát âm
  thanh; không suy ra user đã approve/deny hoặc task đã hoàn tất.
- ID được tính từ nội dung dialog, không phải ID permission duy nhất toàn lịch sử.
  Sau close khớp ID, một open mới dù giống nội dung vẫn có thể thông báo lần mới.
- Khi replay sau reconnect, kiểm tra `status` live trước khi đọc open cũ vì yêu cầu có thể
  đã đóng. Event replay không tự được coi là thông báo mới.
- Khi `resync` do cursor hết hạn hoặc daemon restart, đồng bộ trạng thái từ `status` trong
  im lặng. Trạng thái câu hỏi nằm trong RAM, được dựng lại khi watcher quan sát terminal;
  null ngay lúc daemon khởi động không chứng minh user đã trả lời. Không xóa lịch sử đã
  thông báo chỉ vì disconnect. Nếu mất close/open và ID lặp lại, ưu tiên không báo trùng.
  Giai đoạn này không có lịch sử permission bền vững hay bảo đảm âm thanh đúng một lần.
- Câu hỏi thường vẫn trả lời như trước. `allowPermissions: false` giữ nguyên; không thêm
  endpoint duyệt quyền hay mã lỗi mới. Luồng answer cũ có thể trả receipt `unknown` /
  `NOT_CONFIRMED`; đó không phải duyệt thành công. Không lách bằng `turn.send`, phím
  terminal hoặc tool khác.
- YOLO/allow-all không hiện dialog thì không có thông báo. Login ứng dụng, hộp thoại macOS
  và dialog parser chưa nhận diện không nằm trong phạm vi.

## Kiểm chứng

Tests ở `service.spec.ts` đối chiếu metadata trong event/status/replay, đóng đúng ID và giữ
shape cũ. `core/questions.spec.ts` kiểm tra chuyển metadata. `e2e/questions.e2e.ts` dùng
daemon/terminal thật trong môi trường riêng, engine Claude/Codex giả để kiểm tra event và
luồng approve/deny trên Desktop vẫn hoạt động. Không phải kiểm thử robot thật, giọng nói
hoặc model thật. OS cần PR riêng để triển khai voice và lưu trạng thái đã thông báo.
