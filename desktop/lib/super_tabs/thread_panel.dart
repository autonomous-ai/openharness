import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

/// One thread beside the chat (Dee, 2026-10-29): its root, a "N replies"
/// divider, the replies, and a composer whose reply goes to the root.
class SuperTabThreadPanel extends StatefulWidget {
  const SuperTabThreadPanel({
    super.key,
    required this.controller,
    required this.root,
    required this.row,
    required this.outgoing,
  });

  final SuperTabController controller;
  final String root;

  /// Draws one of the thread's messages as the chat draws it.
  final Widget Function(SuperTabMessage message, bool grouped) row;

  /// Draws a reply on its way.
  final Widget Function(SuperTabOutgoing sent) outgoing;

  @override
  State<SuperTabThreadPanel> createState() => _SuperTabThreadPanelState();
}

class _SuperTabThreadPanelState extends State<SuperTabThreadPanel> {
  late final _composer = TextEditingController(
    text: c.threadDraft(widget.root),
  );
  final _focus = FocusNode();
  bool _alsoSend = false;

  SuperTabController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    _focus.requestFocus();
  }

  @override
  void didUpdateWidget(SuperTabThreadPanel old) {
    super.didUpdateWidget(old);
    if (old.root != widget.root) {
      // Each thread keeps its own draft.
      _composer.text = c.threadDraft(widget.root);
      _alsoSend = false;
    }
  }

  @override
  void dispose() {
    _composer.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Where "Also send" also puts the reply, as the chat is named.
  String get _alsoSendLabel {
    final group = c.selected;
    if (group != null && c.snapshot?.isProjectLead(group.id) == true) {
      return 'Also send to the project chat';
    }
    return group?.number != null
        ? 'Also send to the workgroup'
        : 'Also send to the chat';
  }

  bool get _writable =>
      c.canWrite && c.selected?.archived == false && !c.hasPendingAction;

  Future<void> _send() async {
    if (!_writable || _composer.text.trim().isEmpty) return;
    c.setThreadDraft(widget.root, _composer.text);
    final sending = c.sendThreadReply(alsoSend: _alsoSend);
    if (c.threadDraft(widget.root).isEmpty) {
      _composer.clear();
      setState(() => _alsoSend = false);
    }
    await sending;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final messages = c.threadMessages(widget.root);
    final root = messages.where((m) => m.id == widget.root).firstOrNull;
    final replies = messages.where((m) => m.id != widget.root).toList();
    final pending = c
        .outgoing(c.selectedId)
        .where((sent) => sent.thread == widget.root)
        .toList();
    final count =
        c.thread(c.selectedId, widget.root)?.replies ?? replies.length;
    return Material(
      key: const ValueKey('super-thread-panel'),
      color: DesktopChrome.surface,
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): c.closeThread,
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.controlGap,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text('Thread', style: DesktopChrome.heading()),
                    ),
                  ),
                  AppIconButton(
                    key: const ValueKey('super-thread-close'),
                    icon: AppIcons.close,
                    tooltip: 'Close thread',
                    onPressed: c.closeThread,
                  ),
                ],
              ),
            ),
            Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(
                  vertical: grid.AppDesktop.controlGap,
                ),
                children: [
                  if (root != null) widget.row(root, false),
                  if (count > 0)
                    Padding(
                      key: const ValueKey('super-thread-divider'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: grid.AppDesktop.groupGap,
                        vertical: grid.AppDesktop.controlGap,
                      ),
                      child: Row(
                        children: [
                          Text(
                            count == 1 ? '1 reply' : '$count replies',
                            style: DesktopChrome.metadata(),
                          ),
                          const SizedBox(width: grid.AppDesktop.controlGap),
                          Expanded(
                            child: Divider(
                              height: 1,
                              thickness: 1,
                              color: DesktopChrome.rim,
                            ),
                          ),
                        ],
                      ),
                    ),
                  for (final (index, reply) in replies.indexed)
                    widget.row(
                      reply,
                      index > 0 &&
                          replies[index - 1].authorId == reply.authorId &&
                          replies[index - 1].fromAgent == reply.fromAgent,
                    ),
                  for (final sent in pending) widget.outgoing(sent),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                0,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
              ),
              child: _composerBox(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _composerBox() {
    final writable = _writable;
    return DecoratedBox(
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
            Focus(
              onKeyEvent: (_, event) {
                final keys = HardwareKeyboard.instance;
                final composing = _composer.value.composing;
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.enter &&
                    !keys.isShiftPressed &&
                    !keys.isControlPressed &&
                    !keys.isMetaPressed &&
                    !keys.isAltPressed &&
                    !(composing.isValid && !composing.isCollapsed)) {
                  unawaited(_send());
                  return KeyEventResult.handled;
                }
                return KeyEventResult.ignored;
              },
              child: TextField(
                key: const ValueKey('super-thread-composer'),
                controller: _composer,
                focusNode: _focus,
                enabled: c.canWrite && c.selected?.archived == false,
                minLines: 1,
                maxLines: 6,
                maxLength: 32000,
                keyboardType: TextInputType.multiline,
                style: DesktopChrome.text(),
                decoration: InputDecoration(
                  isCollapsed: true,
                  constraints: const BoxConstraints(),
                  hintText: 'Reply',
                  hintStyle: DesktopChrome.text(color: DesktopChrome.muted),
                  contentPadding: EdgeInsets.zero,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  filled: false,
                  counterText: '',
                ),
                onChanged: (text) {
                  c.setThreadDraft(widget.root, text);
                  setState(() {});
                },
              ),
            ),
            const SizedBox(height: grid.AppDesktop.controlGap),
            Row(
              children: [
                Expanded(
                  child: MergeSemantics(
                    child: Row(
                      children: [
                        Checkbox(
                          key: const ValueKey('super-thread-also-send'),
                          visualDensity: VisualDensity.compact,
                          materialTapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                          value: _alsoSend,
                          onChanged: writable
                              ? (on) => setState(() => _alsoSend = on ?? false)
                              : null,
                        ),
                        Flexible(
                          child: GestureDetector(
                            onTap: writable
                                ? () => setState(() => _alsoSend = !_alsoSend)
                                : null,
                            child: MouseRegion(
                              cursor: writable
                                  ? SystemMouseCursors.click
                                  : MouseCursor.defer,
                              child: Text(
                                _alsoSendLabel,
                                style: DesktopChrome.control(),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                AppIconButton(
                  key: const ValueKey('super-thread-send'),
                  icon: AppIcons.arrowUp,
                  tooltip: 'Send reply',
                  color: DesktopChrome.accent,
                  onPressed: writable && _composer.text.trim().isNotEmpty
                      ? () => unawaited(_send())
                      : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
