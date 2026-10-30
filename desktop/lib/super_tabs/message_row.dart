import 'dart:async';

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
import 'machine_status.dart' show superTabAgo;
import 'message_link.dart';
import 'message_link_preview.dart';
import 'message_more_menu.dart';
import 'message_text.dart';
import 'model.dart';
import 'pull_requests.dart';
import 'reactions.dart';

/// Presentation only. Message identity and reply routing use backend IDs.
class SuperTabMessageRow extends StatefulWidget {
  const SuperTabMessageRow({
    super.key,
    required this.message,
    required this.author,
    required this.onReturnToComposer,
    this.card,
    required this.receipts,
    this.agent,
    this.person,
    this.machineName,
    this.reply,
    this.replyAuthor,
    this.replyGone = false,
    this.grouped = false,
    this.onReply,
    this.onOpenAgent,
    this.onOpenReply,
    this.references = const {},
    this.onOpenGroup,
    this.mentions = const [],
    this.mentionAddresses = const {},
    this.readerId = '',
    this.reactorName,
    this.onReact,
    this.proposalOwner,
    this.headerStatus,
    this.dimmed = false,
    this.thread,
    this.threadUnread = false,
    this.onOpenThread,
    this.threadTrailing,
    this.member,
    this.link,
    this.linkTarget,
    this.onOpenLink,
  });

  final SuperTabMessage message;

  /// The live card [message] is (live_card.dart), drawn in place of its pull
  /// request links; null for a plain message.
  final Widget? card;

  /// The thread [message] is the root of, once it has a reply.
  final SuperTabThread? thread;
  final bool threadUnread;

  /// Opens [message]'s thread: from its reply line, or from an also-sent
  /// reply's mark.
  final VoidCallback? onOpenThread;

  /// Ends the thread line: the mark of a thread's own Buddy session.
  final Widget? threadTrailing;

  /// Who a thread's reply author is in the Swarm now, for the faces on its
  /// reply line; without it each shows the face its recorded name gives.
  final SuperTabMemberOf? member;

  /// The person a Buddy's proposal speaks for, by name, from the server's tag
  /// on it ([SuperTabMessage.proposalOwnerId]); null for any other message.
  final String? proposalOwner;

  /// The names of the people [message] tags.
  final List<String> mentions;

  /// Their addresses, by name: a tag by full address is theirs only when it
  /// is this one.
  final Map<String, String> mentionAddresses;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;
  final String author;
  final SuperTabAgent? agent;

  /// The person who wrote it, while they are in the Swarm.
  final SuperTabPerson? person;
  final String? machineName;
  final SuperTabMessage? reply;
  final String? replyAuthor;

  /// The original [reply] would show is no longer in the conversation.
  final bool replyGone;
  final bool grouped;
  final VoidCallback? onReply, onOpenAgent;

  /// Follows the quote to the original, given this row so that the way back
  /// can return it to the same place on screen.
  final ValueChanged<BuildContext>? onOpenReply;
  final VoidCallback onReturnToComposer;
  final List<Widget> receipts;
  final Widget? headerStatus;

  /// Its text and files are faint while it sends; its status line is not.
  final bool dimmed;

  /// The reader, whose own reactions are marked; [reactorName] names the
  /// others. Without [onReact] the counts only show.
  final String readerId;
  final SuperTabReactorName? reactorName;
  final ValueChanged<SuperTabReactionEmoji>? onReact;

  /// This message's link, for the More menu's Copy link to message. Without
  /// it the menu is not offered.
  final SwarmMessageLink? link;

  /// What a message link in the text points at for the reader, and how to
  /// open it. Without them a link stays plain text.
  final SuperTabLinkTarget Function(SwarmMessageLink)? linkTarget;
  final ValueChanged<SwarmMessageLink>? onOpenLink;

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

  Future<void> _copyLink(SwarmMessageLink link) async {
    await Clipboard.setData(ClipboardData(text: link.url));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text('Link copied'),
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

  Widget _avatar(SuperTabMessage message) {
    const size = SuperTabMessageRow.avatarSize;
    if (widget.agent case final agent?) {
      return SuperTabAvatar.agent(
        agent,
        name: widget.author,
        size: size,
        engineBadge: false,
      );
    }
    if (widget.person case final person? when !message.fromAgent) {
      return SuperTabAvatar.person(person, size: size);
    }
    // Someone no longer in the Swarm keeps the face their recorded name gives.
    return SuperTabAvatar(
      identity: '${message.author['kind']}:${message.authorId}',
      name: message.fromAgent
          ? widget.author
          : superTabPersonName(message.authorName),
      size: size,
      pattern: message.fromAgent,
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final message = widget.message;
    final active = _hovered || _focused;
    // A message that tags the reader stands out, as Slack marks one that
    // names you: an accent bar on its edge over a wash of the accent.
    final taggedYou =
        widget.readerId.isNotEmpty &&
        message.mentions.contains(widget.readerId);
    final authorStyle = DesktopChrome.text(medium: true)
        .copyWith(fontWeight: FontWeight.w600);
    // A phone's author is a finger tall, 44 over its 20 px line. The gap
    // above the row gives up the half that would push the name down and the
    // avatar moves down with it, so both stay where they were.
    final phone = workspaceIsCompact(context);
    final finger = phone && !widget.grouped;
    final slack = finger ? 12.0 : 0.0;
    return Padding(
      padding: EdgeInsets.only(top: widget.grouped ? 0 : 12 - slack),
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
              key: taggedYou
                  ? ValueKey('super-tagged-you-${message.id}')
                  : null,
              decoration: BoxDecoration(
                color: taggedYou
                    ? (active
                          ? grid.AppSurface.accentWashHover
                          : grid.AppSurface.accentWash)
                    : active
                    ? grid.AppSurface.hoverFill
                    : Colors.transparent,
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
                        Container(
                          width: SuperTabMessageRow.avatarSize,
                          padding: EdgeInsets.only(top: slack),
                          child: widget.grouped
                              ? null
                              : ExcludeSemantics(
                                  child: Tooltip(
                                    message: _identityDetails,
                                    child: _avatar(message),
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
                                        child: fingerTarget(
                                          enabled: finger,
                                          Align(
                                            alignment: Alignment.centerLeft,
                                            widthFactor: 1,
                                            heightFactor: 1,
                                            child: Text(
                                              widget.author,
                                              style: authorStyle,
                                            ),
                                          ),
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
                                      if (widget.headerStatus
                                          case final status?)
                                        status
                                      else if (message.createdAt
                                          case final time?)
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
                              if (message.threadReply &&
                                  widget.onOpenThread != null)
                                Padding(
                                  padding: const EdgeInsets.only(
                                    bottom: grid.AppDesktop.menuInset,
                                  ),
                                  child: SuperTabLink(
                                    key: ValueKey(
                                      'super-thread-also-${message.id}',
                                    ),
                                    label: 'Replied in thread, open thread',
                                    onTap: widget.onOpenThread!,
                                    child: Text(
                                      'Replied in thread',
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                ),
                              // A thread reply sits under its root, so it
                              // quotes nothing; an older reply keeps its quote.
                              if (message.replyTo != null &&
                                  !message.threadReply)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: SuperTabReplyPreview(
                                    author:
                                        widget.replyAuthor ??
                                        widget.reply?.authorName ??
                                        'Earlier message',
                                    text:
                                        widget.reply?.text ??
                                        (widget.replyGone
                                            ? 'The original message is no longer in this conversation.'
                                            : 'The original message isn’t loaded.'),
                                    onTap: widget.onOpenReply == null
                                        ? null
                                        : () => widget.onOpenReply!(context),
                                  ),
                                ),
                              if (widget.proposalOwner case final owner?)
                                Padding(
                                  padding: const EdgeInsets.only(
                                    bottom: grid.AppDesktop.menuInset,
                                  ),
                                  child: Container(
                                    key: const ValueKey('super-proposal-label'),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: grid.AppDesktop.controlGap,
                                    ),
                                    decoration: BoxDecoration(
                                      border: Border.all(
                                        color: DesktopChrome.rim,
                                      ),
                                      borderRadius: BorderRadius.circular(
                                        DesktopChrome.rowRadius,
                                      ),
                                    ),
                                    child: Text(
                                      "Proposal · on $owner's behalf",
                                      style: DesktopChrome.metadata(),
                                    ),
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
                                Opacity(
                                  opacity: widget.dimmed ? 0.6 : 1,
                                  child: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxWidth: 960,
                                    ),
                                    child: SuperTabMessageText(
                                      message.text,
                                      references: widget.references,
                                      onOpenGroup: widget.onOpenGroup,
                                      mentions: widget.mentions,
                                      addresses: widget.mentionAddresses,
                                      taggedYou: taggedYou,
                                    ),
                                  ),
                                ),
                              if (message.attachments.isNotEmpty)
                                Opacity(
                                  opacity: widget.dimmed ? 0.6 : 1,
                                  child: Padding(
                                    padding: EdgeInsets.only(
                                      top: message.text.isEmpty ? 0 : 8,
                                    ),
                                    child: SuperTabAttachments(
                                      message.attachments,
                                    ),
                                  ),
                                ),
                              widget.card ??
                                  SuperTabPullRequestLinks(message.text),
                              if (widget.linkTarget case final resolve?)
                                if (widget.onOpenLink case final open?)
                                  SuperTabMessageLinkPreviews(
                                    message.text,
                                    resolve: resolve,
                                    onOpen: open,
                                  ),
                              SuperTabReactionBar(
                                message: message,
                                readerId: widget.readerId,
                                nameOf: widget.reactorName ?? (_, id) => id,
                                onReact: widget.onReact,
                              ),
                              if ((widget.thread, widget.onOpenThread) case (
                                final thread?,
                                final open?,
                              ))
                                SuperTabThreadLine(
                                  key: ValueKey(
                                    'super-thread-line-${message.id}',
                                  ),
                                  thread: thread,
                                  unread: widget.threadUnread,
                                  onOpen: open,
                                  member: widget.member,
                                  trailing: widget.threadTrailing,
                                ),
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
                            if (widget.onReact case final react?)
                              SuperTabReactionPicker(onReact: react),
                            if (widget.onReply != null)
                              fingerTarget(
                                enabled: phone,
                                AppIconButton(
                                  icon: AppIcons.reply,
                                  tooltip: 'Reply',
                                  onPressed: widget.onReply,
                                ),
                              ),
                            fingerTarget(
                              enabled: phone,
                              AppIconButton(
                                icon: AppIcons.copy,
                                tooltip: 'Copy message',
                                onPressed: _copy,
                              ),
                            ),
                            if (widget.link case final link?)
                              fingerTarget(
                                enabled: phone,
                                SuperTabMessageMoreMenu(
                                  key: ValueKey(
                                    'super-message-more-${message.id}',
                                  ),
                                  actions: [
                                    (
                                      label: 'Copy link to message',
                                      icon: AppIcons.link2,
                                      onPressed: () =>
                                          unawaited(_copyLink(link)),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (taggedYou)
                    Positioned(
                      left: 0,
                      top: 0,
                      bottom: 0,
                      child: ColoredBox(
                        key: ValueKey('super-tagged-bar-${message.id}'),
                        color: grid.AppPalette.accentOnSurface,
                        child: const SizedBox(width: 3),
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
    this.onTap,
  });
  final String author, text;

  /// Goes to the quoted message. Without it the quote is only read.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final quote = Container(
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
    if (onTap == null) return quote;
    return Semantics(
      container: true,
      button: true,
      hint: 'Go to original message',
      child: InkWell(onTap: onTap, child: quote),
    );
  }
}

/// Lights a message briefly, as the one a quote was followed to.
class SuperTabMessageHighlight extends StatelessWidget {
  const SuperTabMessageHighlight({
    super.key,
    required this.on,
    required this.child,
  });
  final bool on;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      color: on ? DesktopChrome.selection : Colors.transparent,
      child: child,
    );
  }
}

/// A quiet link in a message: a hand cursor, reached by Tab and pressed with
/// Enter or Space, and a button with [label] to assistive technology. Focus
/// draws the shared rim, reserved at rest so it never moves the words.
class SuperTabLink extends StatefulWidget {
  const SuperTabLink({
    super.key,
    required this.onTap,
    required this.label,
    required this.child,
  });

  final VoidCallback onTap;
  final String label;
  final Widget child;

  @override
  State<SuperTabLink> createState() => _SuperTabLinkState();
}

class _SuperTabLinkState extends State<SuperTabLink> {
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final radius = BorderRadius.circular(DesktopChrome.controlRadius);
    return Semantics(
      button: true,
      label: widget.label,
      child: InkWell(
        onTap: widget.onTap,
        onFocusChange: (focused) => setState(() => _focused = focused),
        mouseCursor: SystemMouseCursors.click,
        borderRadius: radius,
        hoverColor: Colors.transparent,
        focusColor: Colors.transparent,
        highlightColor: Colors.transparent,
        splashFactory: NoSplash.splashFactory,
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: radius,
            border: Border.all(
              color: _focused ? DesktopChrome.focusRing : Colors.transparent,
              width: grid.AppDesktop.focusWidth,
            ),
          ),
          child: ExcludeSemantics(child: widget.child),
        ),
      ),
    );
  }
}

/// Who a message author is in the Swarm as last read, by kind and id: the
/// person, or the agent, whose face their own messages wear. Both are null
/// for someone no longer in it.
typedef SuperTabMemberOf =
    ({SuperTabPerson? person, SuperTabAgent? agent}) Function(
      String kind,
      String id,
    );

/// The line under a thread's root: who replied, how many replies, and when
/// the last came. Bold while the thread has a reply the reader has not seen.
class SuperTabThreadLine extends StatelessWidget {
  const SuperTabThreadLine({
    super.key,
    required this.thread,
    required this.unread,
    required this.onOpen,
    this.member,
    this.trailing,
  });

  final SuperTabThread thread;

  /// Drawn after the line's link, outside it: a thread session's mark.
  final Widget? trailing;
  final bool unread;
  final VoidCallback onOpen;

  /// Dresses each reply author as their own messages are: a person's
  /// picture and status, an agent's avatar.
  final SuperTabMemberOf? member;

  Widget _face(Map<String, dynamic> author) {
    const size = grid.AppDesktop.iconSize;
    final kind = author['kind'] as String? ?? '';
    final id = author['id'] as String? ?? '';
    switch ((kind, member?.call(kind, id))) {
      case ('agent', (agent: final agent?, person: _)):
        return SuperTabAvatar.agent(agent, size: size, engineBadge: false);
      case ('person', (person: final person?, agent: _)):
        return SuperTabAvatar.person(person, size: size);
    }
    // Someone no longer in the Swarm keeps the face their recorded name gives.
    return SuperTabAvatar(
      identity: '$kind:$id',
      name: kind == 'agent'
          ? (author['displayName'] ?? author['name'] ?? 'Agent') as String
          : superTabPersonName(author['name'] as String? ?? ''),
      size: size,
      pattern: kind == 'agent',
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final count = thread.replies == 1 ? '1 reply' : '${thread.replies} replies';
    final last = thread.lastAt;
    final link = SuperTabLink(
      label: unread ? '$count, unread' : count,
      onTap: onOpen,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final author in thread.authors) ...[
            _face(author),
            const SizedBox(width: grid.AppDesktop.menuInset),
          ],
          Text(
            count,
            key: ValueKey('super-thread-count-${thread.id}'),
            style: DesktopChrome.control(
              color: DesktopChrome.accent,
            ).copyWith(fontWeight: unread ? FontWeight.w700 : FontWeight.w500),
          ),
          if (last != null) ...[
            const SizedBox(width: grid.AppDesktop.controlGap),
            Text(
              'Last reply ${superTabAgo(DateTime.now().difference(last))}',
              style: DesktopChrome.metadata(),
            ),
          ],
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.menuInset),
      child: trailing == null
          ? link
          : Row(mainAxisSize: MainAxisSize.min, children: [link, trailing!]),
    );
  }
}
