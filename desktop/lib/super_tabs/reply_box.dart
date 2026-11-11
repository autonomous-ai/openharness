import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/harness_attachments.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import 'chat/send_button.dart';
import 'composer_actions.dart';
import 'composer_files.dart';
import 'composer_newline.dart';
import 'controller.dart';
import 'swarm_type.dart';

/// A thread's reply box, one everywhere a reply is written (the thread pane,
/// the Threads view): files dropped, pasted or attached, Enter sends and
/// ⇧Enter breaks the line. Under the text, one row (Huy and Scholes, 11-04):
/// the paperclip, and the mic (with [onMic]) and the round send at its right
/// end, drawn as Cmd-N's field (anh Dee, 11-07, #4467). An @ typed tags; there is no @ button (River, 11-07).
class SuperTabReplyBox extends StatelessWidget {
  const SuperTabReplyBox({
    super.key,
    required this.controller,
    required this.text,
    required this.focus,
    required this.files,
    required this.enabled,
    required this.writable,
    required this.busy,
    required this.error,
    required this.onEdited,
    required this.onSend,
    this.onMic,
    this.voiceRow,
    this.voiceNotice,
    this.onKey,
    this.inputFormatters = const [],
    this.surfaceKey = const ValueKey('super-thread-composer-surface'),
    this.fieldKey = const ValueKey('super-thread-composer'),
    this.sendKey = const ValueKey('super-thread-send'),
    this.micKey = const ValueKey('super-thread-mic'),
    this.hint = 'Reply',
  });

  final SuperTabController controller;
  final TextEditingController text;
  final FocusNode focus;
  final HarnessAttachments files;

  /// Whether the field takes typing; [writable] whether a reply may go now.
  final bool enabled, writable;

  /// Files going up or a message on its way: the box takes no more.
  final bool busy;
  final String? error;
  final ValueChanged<String> onEdited;
  final VoidCallback onSend;

  /// The mic's press: no mic without one.
  final VoidCallback? onMic;

  /// A voice message under way in this thread: drawn in the row's place.
  final Widget? voiceRow;

  /// The line about its voice message under the row (voice_row.dart), with
  /// its own padding: it takes no room when it has nothing to say.
  final Widget? voiceNotice;

  /// Sees each key first, such as an open @ completion list's arrows and
  /// Enter; a non-null answer is the key's.
  final KeyEventResult? Function(KeyEvent event)? onKey;
  final List<TextInputFormatter> inputFormatters;
  final Key surfaceKey, fieldKey, sendKey, micKey;

  /// The field's hint: what an empty box says it is for.
  final String hint;

  /// The Tab order inside an [OrderedTraversalPolicy] group around the box,
  /// the row's own: the field (and its files) first, then the paperclip, the
  /// mic and send, and last what the owner puts under the box ([underOrder], such as
  /// the pane's Also send). Outside such a group it has no effect, and the
  /// reading order applies.
  static const fieldOrder = NumericFocusOrder(1),
      toolsOrder = NumericFocusOrder(1.5),
      sendOrder = NumericFocusOrder(3),
      underOrder = NumericFocusOrder(4);

  @override
  Widget build(BuildContext context) => NewHarnessDropZone(
    attachments: files,
    enabled: writable && !busy,
    // A folder has no bytes to attach, and its path means nothing to a
    // reader on another computer: say so, as the chat does for a browser.
    onFolders: kIsWeb
        ? null
        : (_) => reportAttachProblem(
            context,
            'A folder can\'t be attached to a reply. Drop its files instead.',
          ),
    child: DecoratedBox(
      key: surfaceKey,
      decoration: BoxDecoration(
        color: DesktopChrome.field,
        borderRadius: BorderRadius.circular(grid.AppDesktop.composerRadius),
        border: Border.all(color: DesktopChrome.rim),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SuperTabComposerChips(controller: controller, files: files),
          Padding(
            padding: composerFieldInsets(target: grid.AppControl.height),
            child: Focus(
              onKeyEvent: (_, event) {
                if (onKey?.call(event) case final handled?) return handled;
                switch (composerEnter(
                  event,
                  focused: focus.hasFocus,
                  value: text.value,
                )) {
                  case ComposerEnter.ignore:
                    return KeyEventResult.ignored;
                  case ComposerEnter.newline:
                    insertComposerNewline(text, onEdited);
                    return KeyEventResult.handled;
                  case ComposerEnter.send:
                    onSend();
                    return KeyEventResult.handled;
                }
              },
              child: NewHarnessPasteTarget(
                attachments: files,
                enabled: writable && !busy,
                focusNode: focus,
                child: TextField(
                  key: fieldKey,
                  controller: text,
                  focusNode: focus,
                  enabled: enabled,
                  minLines: 1,
                  maxLines: 6,
                  maxLength: kComposerMaxLength,
                  inputFormatters: inputFormatters,
                  keyboardType: TextInputType.multiline,
                  style: SwarmType.composer(context),
                  decoration: InputDecoration(
                    isCollapsed: true,
                    constraints: const BoxConstraints(),
                    hintText: hint,
                    hintStyle: SwarmType.composer(
                      context,
                      color: DesktopChrome.hint,
                    ),
                    contentPadding: EdgeInsets.zero,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    filled: false,
                    counterText: '',
                  ),
                  onChanged: onEdited,
                ),
              ),
            ),
          ),
          if (error case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.composerSide,
                0,
                grid.AppDesktop.composerSide,
                grid.AppDesktop.controlGap,
              ),
              child: Text(
                error,
                key: const ValueKey('super-thread-error'),
                style: DesktopChrome.control(),
              ),
            ),
          Padding(
            padding: composerRowInsets(target: grid.AppControl.height),
            // A voice message under way takes the row's place (#2665).
            child: voiceRow != null
                ? FocusTraversalOrder(order: sendOrder, child: voiceRow!)
                : Row(
                    children: [
                      FocusTraversalOrder(
                        order: toolsOrder,
                        child: NewHarnessAttachButton(
                          attachments: files,
                          enabled: writable && !busy,
                        ),
                      ),
                      const Spacer(),
                      if (onMic case final onMic?)
                        FocusTraversalOrder(
                          order: sendOrder,
                          child: SuperTabComposerMic(
                            key: micKey,
                            onPressed: writable ? onMic : null,
                          ),
                        ),
                      FocusTraversalOrder(
                        order: sendOrder,
                        child: ListenableBuilder(
                          listenable: Listenable.merge([files, text]),
                          builder: (context, _) => SwarmSendButton(
                            key: sendKey,
                            tooltip: 'Send reply',
                            onPressed:
                                writable &&
                                    !busy &&
                                    (text.text.trim().isNotEmpty ||
                                        !files.isEmpty)
                                ? onSend
                                : null,
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
          ?voiceNotice,
        ],
      ),
    ),
  );
}
