import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import 'composer_files.dart';
import 'composer_newline.dart';
import 'controller.dart';

/// A thread's reply box, one everywhere a reply is written (the thread pane,
/// the Threads view): files dropped, pasted or attached, Enter sends and
/// ⇧Enter breaks the line, attach and the arrow at its right end. [options]
/// sits left of them, such as the pane's Also send and New session.
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
    this.options,
    this.onKey,
    this.inputFormatters = const [],
    this.surfaceKey = const ValueKey('super-thread-composer-surface'),
    this.fieldKey = const ValueKey('super-thread-composer'),
    this.sendKey = const ValueKey('super-thread-send'),
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
  final Widget? options;

  /// Sees each key first, such as an open @ completion list's arrows and
  /// Enter; a non-null answer is the key's.
  final KeyEventResult? Function(KeyEvent event)? onKey;
  final List<TextInputFormatter> inputFormatters;
  final Key surfaceKey, fieldKey, sendKey;

  /// The field's hint: what an empty box says it is for.
  final String hint;

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
        borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        border: Border.all(color: DesktopChrome.rim),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          grid.AppDesktop.groupGap,
          grid.AppDesktop.controlGap,
          grid.AppDesktop.controlGap,
          grid.AppDesktop.controlGap,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SuperTabComposerChips(controller: controller, files: files),
            Focus(
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
                  style: DesktopChrome.text(),
                  decoration: InputDecoration(
                    isCollapsed: true,
                    constraints: const BoxConstraints(),
                    hintText: hint,
                    hintStyle: DesktopChrome.text(color: DesktopChrome.muted),
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
            if (error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
                child: Text(
                  error,
                  key: const ValueKey('super-thread-error'),
                  style: DesktopChrome.control(),
                ),
              ),
            const SizedBox(height: grid.AppDesktop.controlGap),
            Row(
              children: [
                Expanded(child: options ?? const SizedBox.shrink()),
                NewHarnessAttachButton(
                  attachments: files,
                  enabled: writable && !busy,
                ),
                ListenableBuilder(
                  listenable: Listenable.merge([files, text]),
                  builder: (context, _) => AppIconButton(
                    key: sendKey,
                    icon: AppIcons.arrowUp,
                    tooltip: 'Send reply',
                    color: DesktopChrome.accent,
                    onPressed:
                        writable &&
                            !busy &&
                            (text.text.trim().isNotEmpty || !files.isEmpty)
                        ? onSend
                        : null,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    ),
  );
}
