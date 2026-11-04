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
import 'identity_card.dart';
import 'machine_status.dart' show superTabAgo;
import 'message_link.dart';
import 'message_link_preview.dart';
import 'message_more_menu.dart';
import 'message_text.dart';
import 'model.dart';
import 'pull_requests.dart';
import 'reactions.dart';
import 'swarm_type.dart';

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
    this.mentionLabels = const {},
    this.readerId = '',
    this.reactorName,
    this.onReact,
    this.headerStatus,
    this.dimmed = false,
    this.thread,
    this.threadUnread = false,
    this.threadTagged = false,
    this.onOpenThread,
    this.threadTrailing,
    this.threadEnd,
    this.member,
    this.link,
    this.linkTarget,
    this.onOpenLink,
    this.identity,
  });

  final SuperTabMessage message;

  /// Who wrote it, for the card hovering or focusing its name or avatar shows
  /// (Huy, 11-04); without it the avatar keeps its tooltip.
  final SuperTabIdentityFacts Function()? identity;

  /// The live card [message] is (live_card.dart), drawn in place of its pull
  /// request links; null for a plain message.
  final Widget? card;

  /// The thread [message] is the root of, once it has a reply.
  final SuperTabThread? thread;
  final bool threadUnread;

  /// Whether an unread reply in [thread] tags the reader.
  final bool threadTagged;

  /// Opens [message]'s thread: from its reply line, or from an also-sent
  /// reply's mark.
  final VoidCallback? onOpenThread;

  /// Ends the thread line: the mark of a thread's own Buddy session.
  final Widget? threadTrailing;

  /// After [threadTrailing], outside the thread's link: End session.
  final Widget? threadEnd;

  /// Who a thread's reply author is in the Swarm now, for the faces on its
  /// reply line; without it each shows the face its recorded name gives.
  final SuperTabMemberOf? member;

  /// The names of the people [message] tags.
  final List<String> mentions;

  /// Their addresses, by name: a tag by full address is theirs only when it
  /// is this one.
  final Map<String, String> mentionAddresses;

  /// The name each tagged person shows as, by the name they are tagged by
  /// ([SuperTabMessageText.labels]).
  final Map<String, String> mentionLabels;
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
  static const avatarSize = grid.AppDesktop.messageAvatarSize;
  static const avatarGap = 12.0;
  static const bodyInset = horizontalInset + avatarSize + avatarGap;

  /// Above and below a grouped line, and below a sender's last line.
  static const rowPad = 6.0;

  /// A header at least every this many rows of one run, so the chat can cut
  /// its oldest rows at a header and a page read in above regroups none of
  /// the rows shown (view.dart).
  static const groupLimit = 20;

  static bool _untagged(SuperTabMessage _) => false;

  /// The messages that join the one above them under its header: like Slack,
  /// one sender's messages within five minutes of each other, whatever their
  /// length (Huy, 2026-11-03, #2419), up to [groupLimit] to a group.
  static Set<String> consecutiveUpdates(
    List<SuperTabMessage> messages, {
    bool Function(SuperTabMessage) tagged = _untagged,
  }) {
    final joined = <String>{};
    var first = 0;
    for (var i = 1; i < messages.length; i++) {
      if (i - first < groupLimit &&
          groupsWith(messages[i], messages[i - 1], tagged: tagged)) {
        joined.add(messages[i].id);
      } else {
        first = i;
      }
    }
    return joined;
  }

  /// Whether [current] joins [previous]'s header: the same sender, within five
  /// minutes on the same day. In the chat, a thread reply shown there stands
  /// on its own with its Replied in thread line; [inThread], replies group. A
  /// line that draws its own row has no header to share, on either side, and
  /// a [tagged] row's header is where its tag shows.
  static bool groupsWith(
    SuperTabMessage current,
    SuperTabMessage? previous, {
    bool inThread = false,
    bool Function(SuperTabMessage) tagged = _untagged,
  }) {
    if (previous == null ||
        current.drawsOwnRow ||
        previous.drawsOwnRow ||
        tagged(current) ||
        tagged(previous) ||
        // A message that started a session stands on its own, with its line.
        current.sessionRoot ||
        previous.sessionRoot ||
        // An older reply keeps its quote under its own header.
        (current.replyTo != null && !current.threadReply) ||
        (previous.replyTo != null && !previous.threadReply) ||
        (!inThread && (current.threadReply || previous.threadReply)) ||
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
    const radius = grid.AppDesktop.messageAvatarRadius;
    if (widget.agent case final agent?) {
      return SuperTabAvatar.agent(
        agent,
        name: widget.author,
        size: size,
        engineBadge: false,
        radius: radius,
      );
    }
    if (widget.person case final person? when !message.fromAgent) {
      return SuperTabAvatar.person(person, size: size, radius: radius);
    }
    // Someone no longer in the Swarm keeps the face their recorded name gives.
    return SuperTabAvatar(
      identity: '${message.author['kind']}:${message.authorId}',
      name: message.fromAgent
          ? widget.author
          : superTabPersonName(message.authorName),
      size: size,
      pattern: message.fromAgent,
      radius: radius,
    );
  }

  /// The sender's name: opens the agent when it is one, and shows the card
  /// on hover or keyboard focus, so a person's name takes focus too.
  Widget _name(TextStyle style, bool finger) {
    final name = fingerTarget(
      enabled: finger,
      Align(
        alignment: Alignment.centerLeft,
        widthFactor: 1,
        heightFactor: 1,
        child: Text(widget.author, style: style),
      ),
    );
    final identity = widget.identity;
    if (identity == null) {
      return InkWell(onTap: widget.onOpenAgent, child: name);
    }
    return SuperTabHoverCard(
      facts: identity,
      child: widget.onOpenAgent == null
          ? Focus(
              child: Builder(
                builder: (context) => DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border(
                      bottom: BorderSide(
                        color: Focus.of(context).hasFocus
                            ? DesktopChrome.focusRing
                            : Colors.transparent,
                      ),
                    ),
                  ),
                  child: name,
                ),
              ),
            )
          : InkWell(onTap: widget.onOpenAgent, child: name),
    );
  }

  /// A grouped message's time, shown at its left while it is hovered or
  /// focused, as Slack does: its hour and minute on its first line,
  /// right-aligned under the avatars above, so any time fits the gutter; the
  /// full time and date are on its tooltip and in the row's label.
  Widget? _groupedTime(BuildContext context, bool active) {
    final time = widget.message.createdAt?.toLocal();
    if (!active || time == null) return null;
    final line = SwarmType.body(context);
    final l10n = MaterialLocalizations.of(context);
    final local = TimeOfDay.fromDateTime(time);
    final hour = l10n.formatHour(
      local,
      alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
    );
    return ExcludeSemantics(
      child: SizedBox(
        height: line.fontSize! * line.height!,
        child: OverflowBox(
          maxWidth:
              SuperTabMessageRow.horizontalInset +
              SuperTabMessageRow.avatarSize,
          alignment: Alignment.centerRight,
          child: Tooltip(
            message: '${l10n.formatFullDate(time)}, ${local.format(context)}',
            child: Text(
              '$hour:${l10n.formatMinute(local)}',
              key: ValueKey('super-row-time-${widget.message.id}'),
              softWrap: false,
              style: SwarmType.time(context),
            ),
          ),
        ),
      ),
    );
  }

  /// What assistive technology reads for a grouped message in place of its
  /// header: its sender and time, as a header reads them.
  String get _groupedLabel => switch (widget.message.createdAt) {
    final time? =>
      '${widget.author}, ${TimeOfDay.fromDateTime(time.toLocal()).format(context)}',
    null => widget.author,
  };

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
    final authorStyle = SwarmType.name(context);
    // A phone's author is a finger tall, 44 over its 20 px line. The gap
    // above the row gives up the half that would push the name down and the
    // avatar moves down with it, so both stay where they were.
    final phone = workspaceIsCompact(context);
    final finger = phone && !widget.grouped;
    final slack = finger ? 12.0 : 0.0;
    // A new sender starts a group gap down, and its name a control gap below
    // that, as Slack spaces its senders (Huy, 2026-11-03). A grouped follow-up
    // line keeps its tight spacing.
    final above = widget.grouped ? 0.0 : grid.AppDesktop.groupGap - slack;
    final headerTop = widget.grouped
        ? SuperTabMessageRow.rowPad
        : grid.AppDesktop.controlGap;
    return Padding(
      padding: EdgeInsets.only(top: above),
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
            label: widget.grouped ? _groupedLabel : null,
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
                    padding: EdgeInsets.only(
                      left: SuperTabMessageRow.horizontalInset,
                      right: SuperTabMessageRow.horizontalInset,
                      top: headerTop,
                      bottom: SuperTabMessageRow.rowPad,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: SuperTabMessageRow.avatarSize,
                          padding: EdgeInsets.only(top: slack),
                          child: widget.grouped
                              ? _groupedTime(context, active)
                              : ExcludeSemantics(
                                  child: switch (widget.identity) {
                                    final identity? => SuperTabHoverCard(
                                      facts: identity,
                                      child: _avatar(message),
                                    ),
                                    null => Tooltip(
                                      message: _identityDetails,
                                      child: _avatar(message),
                                    ),
                                  },
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
                                      _name(authorStyle, finger),
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
                                            style: SwarmType.time(context),
                                          ),
                                        ),
                                      if (widget.thread?.askTag case final tag?)
                                        Text(
                                          tag,
                                          style: SwarmType.time(context),
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
                                      labels: widget.mentionLabels,
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
                                      conversationId: message.conversationId,
                                      messageId: message.id,
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
                                  tagged: widget.threadTagged,
                                  onOpen: open,
                                  member: widget.member,
                                  trailing: widget.threadTrailing,
                                  end: widget.threadEnd,
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

  /// Null disables it, for pointer, keyboard and screen readers alike.
  final VoidCallback? onTap;
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
    final enabled = widget.onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      child: InkWell(
        onTap: widget.onTap,
        canRequestFocus: enabled,
        onFocusChange: (focused) => setState(() => _focused = focused),
        mouseCursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
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
/// Like Slack's, it is one padded bar as wide as its words: hover or keyboard
/// focus fills and frames it, reads View thread and shows a chevron, and a
/// click anywhere on it opens the thread (Huy, 2026-11-03, #2315).
class SuperTabThreadLine extends StatelessWidget {
  const SuperTabThreadLine({
    super.key,
    required this.thread,
    required this.unread,
    required this.onOpen,
    this.tagged = false,
    this.member,
    this.trailing,
    this.end,
  });

  final SuperTabThread thread;

  /// Drawn after the line's link, outside it: a thread session's mark.
  final Widget? trailing;

  /// Drawn last, outside the line's link: End session.
  final Widget? end;
  final bool unread, tagged;
  final VoidCallback onOpen;

  /// Dresses each reply author as their own messages are: a person's
  /// picture and status, an agent's avatar.
  final SuperTabMemberOf? member;

  /// Reply authors' faces: at most this many, newest first.
  static const _faces = 5;

  Widget _face(Map<String, dynamic> author) {
    const size = 24.0;
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
    // A session's thread with no reply yet: its mark is the line, and opens it.
    if (thread.replies == 0 && trailing != null) {
      final open = SuperTabLink(
        label: 'Open thread',
        onTap: onOpen,
        child: trailing!,
      );
      return Padding(
        padding: const EdgeInsets.only(top: grid.AppDesktop.menuInset),
        child: end == null ? open : _wrapped([open, _dot, end!]),
      );
    }
    final count = thread.replies == 1 ? '1 reply' : '${thread.replies} replies';
    final last = thread.lastAt;
    final lastReply = last == null
        ? null
        : 'Last reply ${superTabAgo(DateTime.now().difference(last))}';
    final link = _SuperTabThreadBar(
      key: ValueKey('super-thread-bar-${thread.id}'),
      label: [count, if (unread) 'unread', if (tagged) '@ you'].join(', '),
      onTap: onOpen,
      builder: (active) => Row(
        children: [
          for (final author in thread.authors.take(_faces)) ...[
            _face(author),
            const SizedBox(width: grid.AppDesktop.menuInset),
          ],
          // Its words share what the faces leave; the arrow ends the bar.
          Expanded(
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    count,
                    key: ValueKey('super-thread-count-${thread.id}'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(color: DesktopChrome.accent)
                        .copyWith(
                          fontWeight: unread
                              ? FontWeight.w700
                              : FontWeight.w500,
                        ),
                  ),
                ),
                if (tagged) ...[
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  Text(
                    '@ you',
                    key: ValueKey('super-thread-tagged-${thread.id}'),
                    style: DesktopChrome.metadata(color: DesktopChrome.accent),
                  ),
                ],
                const SizedBox(width: grid.AppDesktop.controlGap),
                Flexible(
                  child: Text(
                    active ? 'View thread' : lastReply ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Opacity(
            opacity: active ? 1 : 0,
            child: Icon(
              AppIcons.chevronRight,
              key: ValueKey('super-thread-chevron-${thread.id}'),
              size: AppIcons.inlineSize,
              color: DesktopChrome.muted,
            ),
          ),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.menuInset),
      child: trailing == null
          ? link
          : _wrapped([
              link,
              trailing!,
              if (end != null) ...[_dot, end!],
            ]),
    );
  }

  Widget get _dot =>
      ExcludeSemantics(child: Text(' · ', style: DesktopChrome.metadata()));

  /// On one line while it fits, and on two in a narrow chat.
  Widget _wrapped(List<Widget> children) =>
      Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: children);
}

/// The reply bar: one target, a hand cursor anywhere on it, reached by Tab and
/// pressed with Enter or Space. Hover fills it and draws the rim; focus fills
/// it and draws the blue boundary. Both rims are reserved at rest, so neither
/// moves the words. [builder] is told whether it is hovered or focused, and
/// fills the bar's width: Slack's, or the column's when the chat is narrower
/// (Huy, 2026-11-03, #2373).
class _SuperTabThreadBar extends StatefulWidget {
  const _SuperTabThreadBar({
    super.key,
    required this.label,
    required this.onTap,
    required this.builder,
  });

  final String label;
  final VoidCallback onTap;
  final Widget Function(bool active) builder;

  /// Its width, however wide the chat.
  static const width = 600.0;

  @override
  State<_SuperTabThreadBar> createState() => _SuperTabThreadBarState();
}

class _SuperTabThreadBarState extends State<_SuperTabThreadBar> {
  var _hovered = false;
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final radius = BorderRadius.circular(grid.AppCard.insetRadius);
    final active = _hovered || _focused;
    return Semantics(
      button: true,
      label: widget.label,
      child: LayoutBuilder(
        builder: (context, constraints) => ConstrainedBox(
          constraints: BoxConstraints.tightFor(
            width: constraints.maxWidth < _SuperTabThreadBar.width
                ? constraints.maxWidth
                : _SuperTabThreadBar.width,
          ).copyWith(minHeight: 32),
          child: InkWell(
            onTap: widget.onTap,
            onHover: (hovered) => setState(() => _hovered = hovered),
            onFocusChange: (focused) => setState(() => _focused = focused),
            mouseCursor: SystemMouseCursors.click,
            borderRadius: radius,
            hoverColor: Colors.transparent,
            focusColor: Colors.transparent,
            highlightColor: grid.AppSurface.hoverFill,
            splashFactory: NoSplash.splashFactory,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: active ? grid.AppSurface.hoverFill : Colors.transparent,
                borderRadius: radius,
                border: Border.all(
                  color: _focused
                      ? DesktopChrome.focusRing
                      : _hovered
                      ? DesktopChrome.rim
                      : Colors.transparent,
                  width: grid.AppDesktop.focusWidth,
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: grid.AppDesktop.menuInset,
                ),
                child: ExcludeSemantics(child: widget.builder(active)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
