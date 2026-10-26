import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/finger_target.dart';
import 'attachment_chips.dart';
import 'identity.dart';
import 'message_text.dart';
import 'model.dart';
import 'pull_requests.dart';

/// Presentation only. Message identity and reply routing use backend IDs.
class SuperTabMessageRow extends StatefulWidget {
  const SuperTabMessageRow({
    super.key,
    required this.message,
    required this.author,
    required this.onReturnToComposer,
    required this.receipts,
    this.agent,
    this.machineName,
    this.reply,
    this.replyAuthor,
    this.grouped = false,
    this.onReply,
    this.onOpenAgent,
    this.references = const {},
    this.onOpenGroup,
    this.mentions = const [],
  });

  final SuperTabMessage message;

  /// The names of the people [message] tags.
  final List<String> mentions;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;
  final String author;
  final SuperTabAgent? agent;
  final String? machineName;
  final SuperTabMessage? reply;
  final String? replyAuthor;
  final bool grouped;
  final VoidCallback? onReply, onOpenAgent;
  final VoidCallback onReturnToComposer;
  final List<Widget> receipts;

  // Routing notes share the message body column, including grouped messages.
  static const horizontalInset = 24.0;
  static const avatarSize = 28.0;
  static const avatarGap = 12.0;
  static const bodyInset = horizontalInset + avatarSize + avatarGap;

  /// Compact only a few short updates. Reports and long runs retain their own
  /// speaker identity, so scrolling through agent output does not lose the who.
  static Set<String> consecutiveUpdates(List<SuperTabMessage> messages) {
    final joined = <String>{};
    var first = 0;
    for (var i = 1; i < messages.length; i++) {
      if (i - first < 3 &&
          groupsWith(messages[i], messages[i - 1]) &&
          groupsWith(messages[i], messages[first])) {
        joined.add(messages[i].id);
      } else {
        first = i;
      }
    }
    return joined;
  }

  static bool groupsWith(SuperTabMessage current, SuperTabMessage? previous) {
    if (previous == null ||
        current.replyTo != null ||
        previous.replyTo != null ||
        current.text.length > 280 ||
        previous.text.length > 280 ||
        current.text.contains('\n') ||
        previous.text.contains('\n') ||
        current.text.contains('?') ||
        previous.text.contains('?') ||
        current.text.contains('？') ||
        previous.text.contains('？') ||
        current.authorId.isEmpty ||
        current.authorId != previous.authorId ||
        current.authorName != previous.authorName ||
        current.author['kind'] != previous.author['kind'] ||
        current.author['membershipGeneration'] !=
            previous.author['membershipGeneration'] ||
        current.terminalNote != previous.terminalNote) {
      return false;
    }
    final now = current.createdAt, before = previous.createdAt;
    if (now == null || before == null) return false;
    final elapsed = now.difference(before);
    return !elapsed.isNegative &&
        elapsed <= const Duration(minutes: 5) &&
        DateUtils.isSameDay(now.toLocal(), before.toLocal());
  }

  @override
  State<SuperTabMessageRow> createState() => _SuperTabMessageRowState();
}

class _SuperTabMessageRowState extends State<SuperTabMessageRow> {
  final _focus = FocusNode(debugLabel: 'Swarm message actions');
  bool _hovered = false, _focused = false;

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.message.text));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text('Message copied'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  String get _identityDetails {
    final agent = widget.agent;
    if (agent == null) {
      return widget.message.fromAgent ? 'Agent' : widget.message.authorName;
    }
    return [
      engineIdentity(agent.engine).label,
      for (final key in ['model', 'effort', 'contextWindow'])
        if (agent.configuration[key] case final Object value) '$value',
      if (widget.machineName case final String machine) machine,
    ].join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final message = widget.message;
    final active = _hovered || _focused;
    final authorStyle = DesktopChrome.text(medium: true)
        .copyWith(fontWeight: FontWeight.w600);
    return Padding(
      padding: EdgeInsets.only(top: widget.grouped ? 0 : 12),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: Focus(
          focusNode: _focus,
          onFocusChange: (focused) => setState(() => _focused = focused),
          onKeyEvent: (_, event) {
            if (event is! KeyDownEvent) return KeyEventResult.ignored;
            final keys = HardwareKeyboard.instance;
            if (event.logicalKey == LogicalKeyboardKey.escape) {
              widget.onReturnToComposer();
              return KeyEventResult.handled;
            }
            if (!_focus.hasPrimaryFocus) return KeyEventResult.ignored;
            if (event.logicalKey == LogicalKeyboardKey.keyR &&
                !keys.isMetaPressed &&
                !keys.isControlPressed &&
                !keys.isAltPressed &&
                !keys.isShiftPressed &&
                widget.onReply != null) {
              widget.onReply!();
              return KeyEventResult.handled;
            }
            if (event.logicalKey == LogicalKeyboardKey.keyC &&
                (keys.isMetaPressed || keys.isControlPressed) &&
                !keys.isAltPressed) {
              _copy();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: Semantics(
            container: true,
            label: widget.grouped ? widget.author : null,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: active ? grid.AppSurface.hoverFill : Colors.transparent,
                border: Border.all(
                  color: _focus.hasPrimaryFocus
                      ? DesktopChrome.focusRing
                      : Colors.transparent,
                ),
              ),
              child: Stack(
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: SuperTabMessageRow.horizontalInset,
                      vertical: 6,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: SuperTabMessageRow.avatarSize,
                          child: widget.grouped
                              ? null
                              : ExcludeSemantics(
                                  child: Tooltip(
                                    message: _identityDetails,
                                    child: SuperTabAvatar(
                                      identity:
                                          '${message.author['kind']}:${message.authorId}',
                                      name: message.fromAgent
                                          ? widget.author
                                          : superTabPersonName(
                                              message.authorName,
                                            ),
                                      size: SuperTabMessageRow.avatarSize,
                                    ),
                                  ),
                                ),
                        ),
                        const SizedBox(width: SuperTabMessageRow.avatarGap),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (!widget.grouped) ...[
                                Padding(
                                  padding: const EdgeInsets.only(right: 64),
                                  child: Wrap(
                                    spacing: 8,
                                    runSpacing: 4,
                                    crossAxisAlignment:
                                        WrapCrossAlignment.center,
                                    children: [
                                      InkWell(
                                        onTap: widget.onOpenAgent,
                                        child: Text(
                                          widget.author,
                                          style: authorStyle,
                                        ),
                                      ),
                                      if (message.fromAgent)
                                        Tooltip(
                                          message: _identityDetails,
                                          child: EngineMark(
                                            engine: widget.agent?.engine,
                                            size: 14,
                                          ),
                                        ),
                                      if (message.createdAt case final time?)
                                        Tooltip(
                                          message: MaterialLocalizations.of(
                                            context,
                                          ).formatFullDate(time.toLocal()),
                                          child: Text(
                                            TimeOfDay.fromDateTime(
                                              time.toLocal(),
                                            ).format(context),
                                            style: DesktopChrome.metadata(),
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 4),
                              ],
                              if (message.replyTo != null)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: SuperTabReplyPreview(
                                    author:
                                        widget.replyAuthor ??
                                        widget.reply?.authorName ??
                                        'Earlier message',
                                    text:
                                        widget.reply?.text ??
                                        'The original message isn’t loaded.',
                                  ),
                                ),
                              if (message.terminalNote case final note?)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 6),
                                  child: Text(
                                    note,
                                    style: DesktopChrome.metadata(),
                                  ),
                                ),
                              if (message.text.isNotEmpty)
                                ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: 960,
                                  ),
                                  child: SuperTabMessageText(
                                    message.text,
                                    references: widget.references,
                                    onOpenGroup: widget.onOpenGroup,
                                    mentions: widget.mentions,
                                  ),
                                ),
                              if (message.attachments.isNotEmpty)
                                Padding(
                                  padding: EdgeInsets.only(
                                    top: message.text.isEmpty ? 0 : 8,
                                  ),
                                  child: SuperTabAttachmentChips(
                                    message.attachments,
                                  ),
                                ),
                              SuperTabPullRequestLinks(message.text),
                              ...widget.receipts,
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  Positioned(
                    top: 0,
                    right: 12,
                    child: Opacity(
                      opacity: active ? 1 : 0,
                      alwaysIncludeSemantics: true,
                      child: Material(
                        color: DesktopChrome.surface,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            DesktopChrome.controlRadius,
                          ),
                          side: BorderSide(color: DesktopChrome.rim),
                        ),
                        // A phone's actions are a finger's size each.
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (widget.onReply != null)
                              fingerTarget(
                                enabled: workspaceIsCompact(context),
                                AppIconButton(
                                  icon: AppIcons.reply,
                                  tooltip: 'Reply',
                                  onPressed: widget.onReply,
                                ),
                              ),
                            fingerTarget(
                              enabled: workspaceIsCompact(context),
                              AppIconButton(
                                icon: AppIcons.copy,
                                tooltip: 'Copy message',
                                onPressed: _copy,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class SuperTabReplyPreview extends StatelessWidget {
  const SuperTabReplyPreview({
    super.key,
    required this.author,
    required this.text,
  });
  final String author, text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.only(left: 10),
    decoration: BoxDecoration(
      border: Border(left: BorderSide(color: DesktopChrome.muted, width: 2)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          author,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.control(medium: true),
        ),
        const SizedBox(height: 2),
        Text(
          text.replaceAll(RegExp(r'\s+'), ' '),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(),
        ),
      ],
    ),
  );
}
