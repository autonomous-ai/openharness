# Màn hình Dial, Pro và bản nháp Max

Export ngày 17/11/2026 để chuẩn bị UI/UX cho Harness Max. Ảnh render bằng chính code C của firmware trên máy Mac (không phải ảnh chụp màn thật).

- Dial và Pro: repo `autonomous-harness`, nhánh `main` commit `1e17b388ce`.
- Max: nhánh `feat/harness-max-all` commit `b4e0e70828` (chưa merge, chưa lên board).
- Xem nhanh: mở `gallery.html` (một file, ảnh nhúng sẵn, mở offline được).
- Export lại: `bash export.sh` (xem đầu file để đổi repo, ref, thư mục ra).

## Harness Device (Dial) (258 ảnh)

ESP32-S3 · AMOLED tròn 1,75" 466×466 · cảm ứng · micro · loa · cáp USB

- Chạm mặt kính để nói, chạm lần nữa để gửi. Agent nằm trong app khác (Orca, terminal) thì hiện "See it in Orca".
- Kéo dọc: cuộn pane đang chọn trên máy tính. Vuốt ngang: đổi pane. Kéo không bao giờ bật mic.
- Giữ để mở menu bốn hướng: lên là panes, trái là tabs, phải là inbox, xuống là controls. Trượt rồi thả, về giữa để huỷ.
- Màu: nền than #181818 (Focus nền đen), chữ #EFE7DE, phụ #ADA6AD, một accent tím #C6AAEF, xanh giọng nói #00FF2F, xong #0DBC79, hỏi #E5E510, lỗi #CD3131. Một cỡ chữ giao diện.

Chuyển động: `screens/anim/dial-listening-live.webp`

### Bảng thiết kế Focus (32)

Các trạng thái chính vẽ cho cả hai pet (Claude, Codex) theo mockup newdesign.html. Nhóm này cho thấy rõ nhất ngôn ngữ hình ảnh hiện hành của Dial.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/design-claude-apps.png` | Bộ chọn app. |
| `screens/dial/design-claude-apps-one.png` |  |
| `screens/dial/design-claude-apps-waiting.png` |  |
| `screens/dial/design-claude-controls-no-voice.png` |  |
| `screens/dial/design-claude-machine-view.png` | Machine view: tên app nhỏ dưới tên phiên. |
| `screens/dial/design-claude-machine-view-app.png` |  |
| `screens/dial/design-claude-no-voice-hint.png` |  |
| `screens/dial/design-claude-notice-no-focus.png` | Thông báo của agent khác khi không focus được pane. |
| `screens/dial/design-claude-question.png` | Câu hỏi trong khung tối dưới pet. |
| `screens/dial/design-claude-recap.png` | Recap với pet nhỏ phía trên. |
| `screens/dial/design-claude-rest.png` | Pet Claude nghỉ: "Hold for tabs". |
| `screens/dial/design-claude-voice-listening.png` | Nghe: pet đeo tai nghe. |
| `screens/dial/design-claude-voice-sending.png` | Gửi: pet bỏ thư vào hộp. |
| `screens/dial/design-claude-waiting-orca.png` | Đang chờ người, trong Orca. |
| `screens/dial/design-claude-working.png` | Claude đang làm: pet đầu bếp, việc + thời gian cong ở đáy. |
| `screens/dial/design-claude-working-notice.png` |  |
| `screens/dial/design-codex-apps.png` |  |
| `screens/dial/design-codex-apps-one.png` |  |
| `screens/dial/design-codex-apps-waiting.png` |  |
| `screens/dial/design-codex-controls-no-voice.png` |  |
| `screens/dial/design-codex-machine-view.png` |  |
| `screens/dial/design-codex-machine-view-app.png` |  |
| `screens/dial/design-codex-no-voice-hint.png` |  |
| `screens/dial/design-codex-notice-no-focus.png` |  |
| `screens/dial/design-codex-question.png` |  |
| `screens/dial/design-codex-recap.png` |  |
| `screens/dial/design-codex-rest.png` | Pet Codex nghỉ: "Your move". |
| `screens/dial/design-codex-voice-listening.png` |  |
| `screens/dial/design-codex-voice-sending.png` |  |
| `screens/dial/design-codex-waiting-orca.png` |  |
| `screens/dial/design-codex-working.png` | Codex đang làm. |
| `screens/dial/design-codex-working-notice.png` |  |

### Mặt Focus (16)

Mặt Focus (bật trong cài đặt): nền đen, pet theo engine, tên phiên cong theo mép trên, trạng thái cong ở mép dưới.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/focus.png` |  |
| `screens/dial/focus-connecting.png` | Focus: đang nối. |
| `screens/dial/focus-empty-tabs.png` |  |
| `screens/dial/focus-inbox.png` | Focus: inbox. |
| `screens/dial/focus-panes.png` | Focus: bộ chọn pane. |
| `screens/dial/focus-panes-empty.png` | Tab chưa có pane: "Choose a tab". |
| `screens/dial/focus-panes-scrolled.png` |  |
| `screens/dial/focus-panes-vietnamese.png` |  |
| `screens/dial/focus-question.png` | Focus: câu hỏi. |
| `screens/dial/focus-recap.png` | Focus: recap. |
| `screens/dial/focus-skin.png` |  |
| `screens/dial/focus-tabs.png` | Focus: bộ chọn tab. |
| `screens/dial/focus-voice-bars.png` | Focus: engine không có pet thì vẽ sóng. |
| `screens/dial/focus-voice-listening.png` |  |
| `screens/dial/focus-voice-sending.png` |  |
| `screens/dial/focus-working.png` | Focus: pet đang làm, trạng thái cong ở đáy. |

### Trạng thái nền và kết nối (52)

Mặt mặc định: tên phiên cong mép trên, giữa là "Tap to talk" hoặc việc đang làm. Gồm cả mất kết nối, đang nối, đang cập nhật, ngủ, cần chú ý.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/asleep.png` | Nap (mặt mặc định không vẽ pet). |
| `screens/dial/attention.png` | Có agent chờ người: huy hiệu chuông 1 ở đáy. |
| `screens/dial/booped.png` | Pet bị chạm (mặt mặc định không vẽ pet). |
| `screens/dial/connecting.png` | Đang nối với daemon. |
| `screens/dial/done.png` | Tư thế "xong" (mặt mặc định không vẽ pet). |
| `screens/dial/long-name.png` |  |
| `screens/dial/mobile-restored.png` |  |
| `screens/dial/mobile-working.png` |  |
| `screens/dial/needs-attention.png` | Cần chú ý sau khi có câu hỏi chờ. |
| `screens/dial/offline.png` | Mất cáp: chỉ chữ "Harness". |
| `screens/dial/photo-long-status.png` |  |
| `screens/dial/ready.png` | Sẵn sàng: tên phiên cong ở mép trên, "Tap to talk". |
| `screens/dial/return.png` | Có đoạn đọc dở để quay lại. |
| `screens/dial/short-name-working.png` |  |
| `screens/dial/straight-title.png` |  |
| `screens/dial/unread-persistent.png` |  |
| `screens/dial/updating.png` | Đang cập nhật firmware qua cáp. |
| `screens/dial/working.png` | Đang làm: việc hiện tại màu xanh ở giữa. |
| `screens/dial/working-notifications-activity.png` |  |
| `screens/dial/working-steady-00.png` | 1 trong 32 khung hình của chuỗi này (bật "Hiện khung hình lặp" để xem hết). |
| `screens/dial/working-steady-01.png` |  |
| `screens/dial/working-steady-02.png` |  |
| `screens/dial/working-steady-03.png` |  |
| `screens/dial/working-steady-04.png` |  |
| `screens/dial/working-steady-05.png` |  |
| `screens/dial/working-steady-06.png` |  |
| `screens/dial/working-steady-07.png` |  |
| `screens/dial/working-steady-08.png` |  |
| `screens/dial/working-steady-09.png` |  |
| `screens/dial/working-steady-10.png` |  |
| `screens/dial/working-steady-11.png` |  |
| `screens/dial/working-steady-12.png` |  |
| `screens/dial/working-steady-13.png` |  |
| `screens/dial/working-steady-14.png` |  |
| `screens/dial/working-steady-15.png` |  |
| `screens/dial/working-steady-16.png` |  |
| `screens/dial/working-steady-17.png` |  |
| `screens/dial/working-steady-18.png` |  |
| `screens/dial/working-steady-19.png` |  |
| `screens/dial/working-steady-20.png` |  |
| `screens/dial/working-steady-21.png` |  |
| `screens/dial/working-steady-22.png` |  |
| `screens/dial/working-steady-23.png` |  |
| `screens/dial/working-steady-24.png` |  |
| `screens/dial/working-steady-25.png` |  |
| `screens/dial/working-steady-26.png` |  |
| `screens/dial/working-steady-27.png` |  |
| `screens/dial/working-steady-28.png` |  |
| `screens/dial/working-steady-29.png` |  |
| `screens/dial/working-steady-30.png` |  |
| `screens/dial/working-steady-31.png` |  |
| `screens/dial/working-without-footer.png` |  |

### Giọng nói (44)

Chạm để nói, chạm lần nữa để gửi. Sóng xanh khi nghe, ba ngôi sao khi gửi, bản nháp giọng nói để xem lại trước khi gửi.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/carry-listening.png` |  |
| `screens/dial/completed-listening.png` |  |
| `screens/dial/listening.png` | Đang nghe: sóng xanh. |
| `screens/dial/listening-live-00.png` | 1 trong 32 khung hình của chuỗi này (bật "Hiện khung hình lặp" để xem hết). |
| `screens/dial/listening-live-01.png` |  |
| `screens/dial/listening-live-02.png` |  |
| `screens/dial/listening-live-03.png` |  |
| `screens/dial/listening-live-04.png` |  |
| `screens/dial/listening-live-05.png` |  |
| `screens/dial/listening-live-06.png` |  |
| `screens/dial/listening-live-07.png` |  |
| `screens/dial/listening-live-08.png` |  |
| `screens/dial/listening-live-09.png` |  |
| `screens/dial/listening-live-10.png` |  |
| `screens/dial/listening-live-11.png` |  |
| `screens/dial/listening-live-12.png` |  |
| `screens/dial/listening-live-13.png` |  |
| `screens/dial/listening-live-14.png` |  |
| `screens/dial/listening-live-15.png` |  |
| `screens/dial/listening-live-16.png` |  |
| `screens/dial/listening-live-17.png` |  |
| `screens/dial/listening-live-18.png` |  |
| `screens/dial/listening-live-19.png` |  |
| `screens/dial/listening-live-20.png` |  |
| `screens/dial/listening-live-21.png` |  |
| `screens/dial/listening-live-22.png` |  |
| `screens/dial/listening-live-23.png` |  |
| `screens/dial/listening-live-24.png` |  |
| `screens/dial/listening-live-25.png` |  |
| `screens/dial/listening-live-26.png` |  |
| `screens/dial/listening-live-27.png` |  |
| `screens/dial/listening-live-28.png` |  |
| `screens/dial/listening-live-29.png` |  |
| `screens/dial/listening-live-30.png` |  |
| `screens/dial/listening-live-31.png` |  |
| `screens/dial/lit-draft.png` |  |
| `screens/dial/lit-draft-options.png` |  |
| `screens/dial/search-listening.png` |  |
| `screens/dial/summary-listening.png` |  |
| `screens/dial/voice-draft.png` | Bản nháp giọng nói trước khi gửi. |
| `screens/dial/voice-draft-options.png` | Tuỳ chọn bản nháp: thêm, hoàn tác, quay lại. |
| `screens/dial/voice-retry.png` | Gửi giọng nói lỗi: "Try again". |
| `screens/dial/voice-review-hold.png` | Giữ để xem trước bản ghi. |
| `screens/dial/voice-transmitting.png` | Đang gửi giọng nói: ba ngôi sao. |

### Kết quả lượt (recap) (17)

Lượt xong thì hiện tóm tắt trong khung tối, cắt theo câu trọn vẹn (tối đa 180 ký tự). Lượt mới che recap cũ.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/acknowledgment-explanation.png` |  |
| `screens/dial/complete-sentence.png` |  |
| `screens/dial/completed.png` | Recap: lượt xong, tóm tắt trong khung tối. |
| `screens/dial/completed-attention.png` | Recap trong lúc agent khác đang chờ. |
| `screens/dial/completed-quiet-footer.png` |  |
| `screens/dial/continued-sentence.png` |  |
| `screens/dial/growth-arrows.png` |  |
| `screens/dial/long-reading.png` | Recap dài, đọc bằng cách kéo. |
| `screens/dial/next-result.png` |  |
| `screens/dial/next-turn.png` | Lượt mới bắt đầu: recap cũ bị che. |
| `screens/dial/photo-summary-board.png` |  |
| `screens/dial/photo-summary-dials.png` |  |
| `screens/dial/photo-summary-spacing.png` |  |
| `screens/dial/punctuation.png` |  |
| `screens/dial/summary-fraction.png` |  |
| `screens/dial/summary-symbols.png` |  |
| `screens/dial/three-sentences.png` |  |

### Inbox và thông báo (26)

[1] báo có tin chưa đọc. Inbox xếp từng tin một trang, mở tin thì focus pane đó trên máy tính và đánh dấu đã đọc.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/bell-all-read.png` |  |
| `screens/dial/clear-notification.png` |  |
| `screens/dial/inbox-handled.png` |  |
| `screens/dial/inbox-offline.png` | Inbox khi agent đã offline. |
| `screens/dial/inbox-open-pressed.png` |  |
| `screens/dial/inbox-question.png` | Inbox: tin là câu hỏi. |
| `screens/dial/inbox-read-stays.png` |  |
| `screens/dial/inbox-unread.png` | Inbox: một tin chưa đọc (máy, agent, nội dung). |
| `screens/dial/lit-inbox-empty.png` |  |
| `screens/dial/long-curved-notification.png` |  |
| `screens/dial/long-reading-inbox.png` |  |
| `screens/dial/mail-lift.png` |  |
| `screens/dial/mail-with-summary.png` |  |
| `screens/dial/notification-clipped.png` |  |
| `screens/dial/notification-fraction.png` |  |
| `screens/dial/notification-glance-left.png` |  |
| `screens/dial/notification-glance-right.png` |  |
| `screens/dial/notification-long-reading.png` |  |
| `screens/dial/notification-missing.png` |  |
| `screens/dial/notification-multiple.png` | Nhiều tin: 1/2, mũi tên sang tin sau. |
| `screens/dial/notification-opened.png` |  |
| `screens/dial/notification-preview.png` |  |
| `screens/dial/notification-punctuation.png` |  |
| `screens/dial/notification-question.png` |  |
| `screens/dial/notification-short.png` |  |
| `screens/dial/notification-symbols.png` |  |

### Câu hỏi của agent (23)

Agent hỏi thì hiện câu hỏi, lựa chọn, trả lời bằng giọng nói, xem lại rồi gửi. Có cả lỗi và trường hợp host không hỗ trợ.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/caps-question-no-answer.png` |  |
| `screens/dial/caps-question-no-say.png` |  |
| `screens/dial/lit-answer-draft.png` |  |
| `screens/dial/lit-answer-error.png` |  |
| `screens/dial/lit-answer-review.png` | Trang chữ: xem lại câu trả lời. |
| `screens/dial/lit-answer-waiting.png` |  |
| `screens/dial/lit-choices.png` | Trang chữ: chọn một trong ba. |
| `screens/dial/lit-choices-selected.png` |  |
| `screens/dial/lit-question.png` | Trang chữ: câu hỏi, [later] [say] [next]. |
| `screens/dial/lit-question-error.png` |  |
| `screens/dial/lit-question-failed.png` |  |
| `screens/dial/lit-question-loading.png` |  |
| `screens/dial/lit-question-short.png` |  |
| `screens/dial/lit-question-unsupported.png` |  |
| `screens/dial/question.png` |  |
| `screens/dial/question-choice.png` | Câu hỏi có lựa chọn. |
| `screens/dial/question-end.png` |  |
| `screens/dial/question-listening.png` |  |
| `screens/dial/question-multi-review.png` |  |
| `screens/dial/question-refused.png` | Host từ chối câu trả lời. |
| `screens/dial/question-review.png` | Xem lại câu trả lời trước khi gửi. |
| `screens/dial/question-shown-only.png` |  |
| `screens/dial/question-spoken-review.png` |  |

### Tab, pane, app và máy (21)

Giữ rồi kéo lên: panes, kéo trái: tabs. Vuốt ngang để đổi pane. Machine view và bộ chọn app (Ghostty, VS Code, Orca).

| Ảnh | Nội dung |
|---|---|
| `screens/dial/apps.png` | Bộ chọn app: Ghostty, 3 agent. |
| `screens/dial/apps-one.png` |  |
| `screens/dial/apps-waiting.png` | Bộ chọn app: VS Code có 1 agent đang chờ. |
| `screens/dial/caps-machine-view.png` | Machine view khi agent ở Orca. |
| `screens/dial/caps-machine-view-app.png` |  |
| `screens/dial/caps-waiting-orca.png` |  |
| `screens/dial/hold-tabs.png` | Giữ rồi kéo trái: chọn tab. |
| `screens/dial/lit-machines.png` | Danh sách máy: ready, offline. |
| `screens/dial/lit-machines-empty.png` |  |
| `screens/dial/lit-workspace-preview.png` |  |
| `screens/dial/lit-workspace-preview-long.png` |  |
| `screens/dial/panes.png` | Bộ chọn pane trong tab. |
| `screens/dial/shortcut-tabs.png` |  |
| `screens/dial/tabs-dragging.png` |  |
| `screens/dial/tabs-empty.png` | Chưa có tab. |
| `screens/dial/tabs-from-gesture.png` |  |
| `screens/dial/tabs-last.png` |  |
| `screens/dial/tabs-long-name.png` |  |
| `screens/dial/tabs-names.png` | Bộ chọn tab: tab giữa xanh, hai bên ló ra. |
| `screens/dial/tabs-settling.png` |  |
| `screens/dial/workspace-home.png` |  |

### Controls (8)

Giữ rồi kéo xuống: danh sách lệnh (Inbox, Machines, Model, Stop current turn, Nap, Find, New Harness).

| Ảnh | Nội dung |
|---|---|
| `screens/dial/caps-controls-no-voice.png` |  |
| `screens/dial/controls.png` | Controls: Inbox, Machines, Model, Stop current turn. |
| `screens/dial/controls-core.png` | Controls khi host không có lệnh tuỳ chọn. |
| `screens/dial/controls-core-scroll.png` |  |
| `screens/dial/lit-controls.png` |  |
| `screens/dial/lit-controls-pressed.png` |  |
| `screens/dial/lit-controls-scrolled.png` |  |
| `screens/dial/reading-controls.png` |  |

### Chọn chữ, mang đoạn, tìm (12)

Chọn đoạn trong pane, "mang" đoạn đó sang agent khác, tìm trong output bằng giọng nói.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/carry-after-return.png` |  |
| `screens/dial/carry-expired-return.png` |  |
| `screens/dial/carry-home.png` | Đang mang một đoạn: "Do anything", thả để đọc. |
| `screens/dial/carry-return.png` |  |
| `screens/dial/find-named.png` |  |
| `screens/dial/lit-selection.png` |  |
| `screens/dial/lit-selection-pending.png` |  |
| `screens/dial/output-search.png` |  |
| `screens/dial/output-search-empty.png` |  |
| `screens/dial/reading-return.png` |  |
| `screens/dial/selection.png` | Chọn chữ: [find] [line] [carry]. |
| `screens/dial/selection-range.png` |  |

### New Harness (5)

Tạo agent mới từ Dial: form nhiều bước, nói tên dự án.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/lit-form.png` | New Harness: chọn engine và thư mục. |
| `screens/dial/lit-form-error.png` |  |
| `screens/dial/new-harness.png` | New Harness: form tạo agent mới. |
| `screens/dial/new-harness-stale.png` |  |
| `screens/dial/spoken-project.png` | New Harness: nói tên dự án. |

### Khi host thiếu khả năng (2)

Agent chạy trong app khác (Orca, terminal) nên Dial không nghe hộ được: hiện "See it in Orca" thay cho mic.

| Ảnh | Nội dung |
|---|---|
| `screens/dial/caps-no-voice-hint.png` | Agent trong Orca: chạm thì hiện "See it in Orca". |
| `screens/dial/caps-notice-no-focus.png` |  |

## Harness Pro (72 ảnh)

ESP32-P4 · màn vuông 720×720 · cảm ứng GT911 · nút cạnh · micro · chỉ qua cáp (không Wi-Fi)

- Sáu view: Home (thẻ tab), phòng agent, recap, talk, Notices, cập nhật. Không có view danh sách agent trong tab: thẻ tab mở thẳng agent.
- Nút cạnh: bấm để huỷ ghi âm, lùi một cấp, hoặc về Home; giữ 0,8 s để tắt hoặc bật màn.
- Agent xong thì mở thẳng recap; agent bắt đầu làm lại thì recap tự lật về phòng agent.
- Chữ Inter và JetBrains Mono. Nền navy, bong bóng màu giấy ấm; thẻ tab theo màu engine (Claude cam, Codex xanh).

Chuyển động: `screens/anim/pro-agent-cli.webp`, `screens/anim/pro-agent-fw.webp`, `screens/anim/pro-tabs-working.webp`, `screens/anim/pro-talk-fw.webp`

### Home (thẻ tab) (19)

Mỗi tab là một thẻ bìa 540×560: tên, số agent cỡ lớn, pill trạng thái (đang làm, đang hỏi, All done), hàng logo engine. Thẻ Notices đứng đầu khi có thông báo, thẻ Working (pet các agent đang chạy) đứng sau. Vuốt ngang đổi thẻ, chạm để vào.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/notice-failed.png` | Pill cập nhật lỗi, sẽ thử lại. |
| `screens/pro/notice-updated.png` | Pill "Updated to 0.1.3" sau khi cập nhật. |
| `screens/pro/tabs.png` | Home: thẻ tab Firmware, 2 agent đang làm; tab kế bên ló ra. |
| `screens/pro/tabs-0+2.png` | Home ở tab 0, thêm 2 tab. |
| `screens/pro/tabs-1.png` | Home ở tab 1. |
| `screens/pro/tabs-2+2.png` | Home ở tab 2, thêm 2 tab. |
| `screens/pro/tabs-3.png` | Home ở tab 3. |
| `screens/pro/tabs-5.png` | Home ở tab 5. |
| `screens/pro/tabs-9.png` | Chín tab, nhiều hơn một trang. |
| `screens/pro/tabs-bell.png` | Home khi có tin chưa đọc (Home không vẽ chuông). |
| `screens/pro/tabs-linkdown.png` | Mất cáp. |
| `screens/pro/tabs-long.png` | Tên tab dài tối đa. |
| `screens/pro/tabs-mock.png` | Home theo mockup gốc: Harness repo, 6 agent. |
| `screens/pro/tabs-none.png` | Màn đầu: chưa có tab nào. |
| `screens/pro/tabs-notices.png` | Thẻ Notices: số tin mới, ba hàng đầu. |
| `screens/pro/tabs-seven.png` | Thẻ 7 agent: 4 làm, 1 hỏi, 4 logo và +3. |
| `screens/pro/tabs-single.png` | Một tab, một agent: "All done". |
| `screens/pro/tabs-working.png` | Thẻ Working: pet của agent đang chạy, tên và thời gian. |
| `screens/pro/tabs-working-codex.png` | Thẻ Working với các agent Codex và Muse. |

### Phòng agent (15)

Một pet cỡ 2x trên nền, bong bóng nói việc đang làm hoặc câu hỏi, tên agent ở trên. Vuốt ngang sang agent kế.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/agent-be.png` | Codex đang chạy test. |
| `screens/pro/agent-be-offline.png` | Máy của agent offline: "My machine is offline." |
| `screens/pro/agent-cli.png` | Codex đang hỏi: bong bóng câu hỏi trắng, dấu "?". |
| `screens/pro/agent-cli-long.png` | Câu hỏi dài. |
| `screens/pro/agent-desk.png` | Agent đã xong thì mở thẳng recap. |
| `screens/pro/agent-fw.png` | Claude đang sửa code: pet đầu bếp, bong bóng việc đang làm, thời gian. |
| `screens/pro/agent-fw-ask.png` | Claude đang hỏi. |
| `screens/pro/agent-fw-failed.png` | Phòng agent kèm pill cập nhật lỗi. |
| `screens/pro/agent-fw-long.png` | Việc đang làm dài, cắt bằng dấu ba chấm. |
| `screens/pro/agent-fw-notice.png` | Pill "Didn't catch that" khi giọng nói không nhận được. |
| `screens/pro/agent-fw-scroll.png` | Phòng agent sau khi cuộn. |
| `screens/pro/agent-fw-unread.png` | Phòng agent khi có tin chưa đọc. |
| `screens/pro/agent-fw-updated.png` | Phòng agent kèm pill đã cập nhật. |
| `screens/pro/agent-kilo.png` | Kilo không có pet: logo đứng chỗ pet. |
| `screens/pro/agent-web-ask.png` | Muse đang hỏi. |

### Recap (12)

Agent xong (hoặc lỗi) thì vào thẳng recap: bong bóng tóm tắt tối đa 8 dòng, pet "ký tên" bên dưới. Lỗi thì bong bóng hồng. Kéo dọc để cuộn pane trên máy tính.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/recap-desk.png` | Recap: bong bóng tóm tắt, pet ký tên. |
| `screens/pro/recap-desk-extreme.png` | Recap cực dài. |
| `screens/pro/recap-desk-long.png` | Recap dài: dòng cuối nhạt, ba chấm. |
| `screens/pro/recap-desk-medium.png` | Recap hai câu. |
| `screens/pro/recap-desk-short.png` | Recap ngắn: "All green." |
| `screens/pro/recap-desk-testfail.png` | Recap khi test lỗi. |
| `screens/pro/recap-desk-unread.png` | Recap chưa đọc. |
| `screens/pro/recap-desk-viet.png` | Recap tiếng Việt có đường dẫn dài. |
| `screens/pro/recap-docs.png` | Recap của Codex. |
| `screens/pro/recap-docs-long.png` | Recap Codex dài. |
| `screens/pro/recap-docs-unreadfail.png` | Lượt lỗi chưa đọc: bong bóng hồng. |
| `screens/pro/recap-kilo.png` | Recap của engine không có pet. |

### Talk (giọng nói) (7)

Đang nghe: pet đeo tai nghe. Đang gửi: pet bỏ thư. Engine không có pet thì vẽ sóng 7 thanh xanh và ba ngôi sao như Dial.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/talk-be.png` | Codex đang nghe. |
| `screens/pro/talk-be-send.png` | Codex đang gửi. |
| `screens/pro/talk-cur.png` | Cursor (không có pet): sóng 7 thanh xanh. |
| `screens/pro/talk-cur-send.png` | Cursor đang gửi: ba ngôi sao. |
| `screens/pro/talk-fw.png` | Đang nghe: pet Claude đeo tai nghe. |
| `screens/pro/talk-fw-quiet.png` | Đang nghe khi người chưa nói. |
| `screens/pro/talk-fw-send.png` | Đang gửi: pet bỏ thư vào hộp. |

### Notices (inbox) (4)

Danh sách: agent đang hỏi trước, rồi tin chưa đọc mới nhất. Mỗi hàng là avatar pet + bong bóng (tên, tuổi, 2 dòng). Chạm để mở.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/inbox.png` | Notices: 5 tin, câu hỏi đứng đầu. |
| `screens/pro/inbox-failed.png` | Notices có lượt lỗi. |
| `screens/pro/inbox-quiet.png` | Notices chỉ còn agent đang hỏi. |
| `screens/pro/inbox-viet.png` | Notices có nội dung tiếng Việt. |

### Toast và banner (11)

Thông báo của agent khác trượt xuống trên cùng khi đang ở phòng hoặc recap; ảnh @ms là thời điểm sau khi toast hiện.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/agent-cli-banner.png` |  |
| `screens/pro/agent-fw-banner.png` |  |
| `screens/pro/agent-fw-toast@0.png` |  |
| `screens/pro/agent-fw-toast@200.png` |  |
| `screens/pro/agent-fw-toast@2500.png` |  |
| `screens/pro/agent-fw-toast@4900.png` |  |
| `screens/pro/recap-desk-banner.png` |  |
| `screens/pro/recap-desk-toast@200.png` |  |
| `screens/pro/recap-desk-toast@2500.png` |  |
| `screens/pro/recap-docs-toast@4900.png` |  |
| `screens/pro/tabs-banner.png` | Home kèm toast. |

### Cập nhật firmware (4)

Vòng tiến trình, "Updating to 0.1.2", nhắc giữ cáp. Màn này bỏ qua mọi chạm.

| Ảnh | Nội dung |
|---|---|
| `screens/pro/ota-0.png` | Bắt đầu cập nhật. |
| `screens/pro/ota-100.png` | Ghi xong 100%. |
| `screens/pro/ota-62.png` | Đang cập nhật 62%. |
| `screens/pro/ota-restart.png` | Khởi động lại vào bản mới. |

## Harness Max (bản nháp hiện tại) (12 ảnh)

ESP32-P4 · màn 8,8" dùng nằm ngang 1920×480 · cảm ứng GT9271 · cáp USB · chưa lên bench

- Bản nháp chưa merge (nhánh feat/harness-max-all, commit b4e0e70828), mốc 0 và 1 của roadmap; chưa lên board thật.
- Rail bên trái (máy và số agent), ba làn agent, ô Talk bên phải. Agent cần người đứng trước, rồi agent đang làm.
- Chạm một làn để chọn và mở agent đó trên máy tính. Chạm Talk để nói với agent đang chọn.
- Chưa có ở mốc này: trả lời và duyệt từ thanh, tạo agent mới, Wi-Fi.

### Bản nháp Max (12)

| Ảnh | Nội dung |
|---|---|
| `screens/max-draft/asking.png` | Agent hỏi: làn vàng, đứng đầu (chỉ đọc ở mốc này). |
| `screens/max-draft/failed.png` | Lượt lỗi: làn đỏ. |
| `screens/max-draft/five-p1.png` | Năm agent, trang 1 (chấm trang ở đáy). |
| `screens/max-draft/five-p2.png` | Năm agent, trang 2. |
| `screens/max-draft/linkdown.png` | Mất cáp: "Not connected". |
| `screens/max-draft/listening.png` | Đang nghe cho backend: ô Talk đỏ, làn được chọn có viền. |
| `screens/max-draft/long.png` | Chữ dài trong làn. |
| `screens/max-draft/noagents.png` | Có cáp, chưa có agent. |
| `screens/max-draft/notice.png` | Toast "Sent to backend". |
| `screens/max-draft/sending.png` | Đang gửi. |
| `screens/max-draft/update.png` | Đang cập nhật firmware. |
| `screens/max-draft/working.png` | Ba làn đang làm: tên, engine, máy, trạng thái, việc, bước gần nhất, thời gian. |

## Dial, Pro làm được gì mà bản nháp Max chưa vẽ

| Chủ đề | Dial | Pro | Max nháp |
|---|---|---|---|
| Tổng quan theo tab / swarm | Bộ chọn tab, pane, app | Home thẻ tab, thẻ Working | Chỉ có rail máy + phân trang làn |
| Recap khi xong lượt | Khung recap, cắt theo câu | Bong bóng recap, pet ký tên | Trạng thái "Done" + tóm tắt trong làn |
| Inbox / Notices | Inbox từng tin một trang | Danh sách Notices | Chưa có (chỉ toast) |
| Trả lời câu hỏi | Lựa chọn, giọng nói, xem lại, gửi | Chỉ hiện câu hỏi | Chỉ đọc (mốc sau) |
| Pet và chuyển động | Pet Focus theo engine | Pet 2x, cảnh làm việc/nghe/gửi | Không có pet |
| Giọng nói lỗi / thử lại | Try again, bản nháp | Huỷ bằng nút cạnh | Chưa vẽ |
| Controls / lệnh | Stop turn, Model, Nap, New Harness | Không có | Không có |
| Máy offline | Danh sách máy | "My machine is offline." | Rail ghi "Offline" |
| Cập nhật firmware | Màn Updating | Vòng tiến trình + pill kết quả | Có (update) |

Biến thể không export: theme cam của Dial (`DEVICE_HABITAT_ORANGE`, chỉ đổi accent tím thành cam #FF6D00).
