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
import 'chat/bubble.dart';
import 'composer_newline.dart';
import 'identity.dart';
import 'machine_status.dart' show superTabAgo;
import 'message_link.dart';
import 'message_link_preview.dart';
import 'message_more_menu.dart';
import 'message_text.dart';
import 'model.dart';
import 'pull_requests.dart';
import 'swarm_type.dart';
import 'voice_length.dart';

/// The face [message]'s row shows for its sender, shown as [author]: the
/// [agent] or [person] who wrote it, while they are in the Swarm.
Widget superTabMessageAvatar(
  SuperTabMessage message, {
  required String author,
  SuperTabAgent? agent,
  SuperTabPerson? person,
  double size = SuperTabMessageRow.avatarSize,
}) {
  if (agent != null) {
    return SuperTabAvatar.agent(
      agent,
      name: author,
      size: size,
      engineBadge: false,
    );
  }
  if (person != null && !message.fromAgent) {
    return SuperTabAvatar.person(person, size: size);
  }
  // Someone no longer in the Swarm keeps the face their recorded name gives.
  return SuperTabAvatar(
    identity: '${message.author['kind']}:${message.authorId}',
    name: message.fromAgent ? author : superTabPersonName(message.authorName),
    size: size,
    face: message.fromAgent,
  );
}

/// Presentation only. Message identity and reply routing use backend IDs.
class SuperTabMessageRow extends StatefulWidget {
  const SuperTabMessageRow({
    super.key,
    required this.message,
    required this.author,
    required this.onReturnToComposer,
    required this.receipts,
    this.agent,
    this.person,
    this.machineName,
    this.reply,
    this.replyAuthor,
    this.replyGone = false,
    this.grouped = false,
    this.joinsBelow = false,
    this.oneOnOne = false,
    this.to = const [],
    this.onReply,
    this.onOpenAgent,
    this.onOpenReply,
    this.references = const {},
    this.onOpenGroup,
    this.mentions = const [],
    this.agentNames = const [],
    this.mentionAddresses = const {},
    this.mentionLabels = const {},
    this.readerId = '',
    this.headerStatus,
    this.dimmed = false,
    this.thread,
    this.threadUnread = false,
    this.onOpenThread,
    this.threadTrailing,
    this.threadEnd,
    this.member,
    this.link,
    this.linkTarget,
    this.onOpenLink,
    this.onMarkUnread,
    this.onEdit,
    this.onDelete,
  });

  final SuperTabMessage message;

  /// The thread [message] is the root of, once it has a reply.
  final SuperTabThread? thread;
  final bool threadUnread;

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

  /// The Swarm's agents' names, read as tags where the text says them (Swarm v4).
  final List<String> agentNames;

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

  /// The row below is the same sender's, joined to this one: this bubble's
  /// lower corner meets it, and a group chat's face waits for the last.
  final bool joinsBelow;

  /// The chat has one other party (a Buddy chat, an agent chat): no names and
  /// no faces, as a one-on-one iMessage draws it.
  final bool oneOnOne;

  /// The teammates a post is to ([superTabPostTo]), by the name their tags read: each its words do not tag opens its bubble
  /// (`@Juno`), as a group chat addresses a post.
  final List<String> to;
  final VoidCallback? onReply, onOpenAgent;

  /// Follows the quote to the original, given this row so that the way back
  /// can return it to the same place on screen.
  final ValueChanged<BuildContext>? onOpenReply;
  final VoidCallback onReturnToComposer;
  final List<Widget> receipts;
  final Widget? headerStatus;

  /// Its text and files are faint while it sends; its status line is not.
  final bool dimmed;

  /// The reader: their own messages sit on their side, and a message that
  /// tags them is marked.
  final String readerId;

  /// This message's link, for the More menu's Copy link to message. Without
  /// it the menu is not offered.
  final SwarmMessageLink? link;

  /// What a message link in the text points at for the reader, and how to
  /// open it. Without them a link stays plain text.
  final SuperTabLinkTarget Function(SwarmMessageLink)? linkTarget;
  final ValueChanged<SwarmMessageLink>? onOpenLink;

  /// The More menu's Mark unread: the chat reads as unread from this message
  /// on. Null where it is not offered.
  final VoidCallback? onMarkUnread;

  /// The More menu's Edit message: the text turns into a field here, and
  /// this sends what it says once changed. Null where it is not offered (it
  /// is only the author's, on their own plain message).
  final Future<void> Function(String text)? onEdit;

  /// The More menu's Delete message, which asks first. Null where it is not
  /// offered.
  final VoidCallback? onDelete;

  /// What a deleted message that keeps its thread reads as (backend
  /// messageEdits.ts `DELETED_TEXT`).
  static const deletedText = 'This message was deleted.';

  // Routing notes share the message body column, including grouped messages.
  static const horizontalInset = 24.0;
  static const avatarSize = grid.AppDesktop.messageAvatarSize;
  static const avatarGap = 12.0;
  static const bodyInset = horizontalInset + avatarSize + avatarGap;

  /// Above and below a grouped line, and below a sender's last line.
  static const rowPad = 6.0;

  /// Another's bubble, and a card, takes at most this share of the row: an agent's words read nearly the column's width, as
  /// Codex's answers do (anh Dee, 2026-11-10: "the center chat area is too small").
  static const bubbleShare = .92;

  /// Your own bubble takes at most this share, on the right (anh Dee's mockup, 11-07), as Codex keeps yours narrower.
  static const ownBubbleShare = .75;

  /// The share of the row [own]'s bubble takes at most.
  static double shareOf({required bool own}) =>
      own ? ownBubbleShare : bubbleShare;

  /// The room between one sender's joined bubbles.
  static const joinedGap = 2.0;

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
  final _editFocus = FocusNode(debugLabel: 'Swarm message edit');
  bool _hovered = false, _focused = false;

  /// The text being edited, while Edit message is open; [_saving] while it
  /// is on its way.
  TextEditingController? _editing;
  bool _saving = false;

  @override
  void dispose() {
    _focus.dispose();
    _editFocus.dispose();
    _editing?.dispose();
    super.dispose();
  }

  void _startEdit() {
    _editing?.dispose();
    final text = widget.message.text;
    setState(
      () =>
          _editing = TextEditingController(text: text)
            ..selection = TextSelection.collapsed(offset: text.length),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _editFocus.requestFocus();
    });
  }

  void _stopEdit() {
    final editing = _editing;
    if (editing == null) return;
    setState(() {
      _editing = null;
      _saving = false;
    });
    // Disposed after the frame that drops its field.
    WidgetsBinding.instance.addPostFrameCallback((_) => editing.dispose());
    widget.onReturnToComposer();
  }

  /// Saves the field: unchanged text only closes it. A refusal is told by
  /// [SuperTabMessageRow.onEdit]'s caller; the row shows the text it has.
  Future<void> _saveEdit() async {
    final editing = _editing, save = widget.onEdit;
    if (editing == null || save == null || _saving || !_canSave) return;
    final text = editing.text.trim();
    if (text == widget.message.text) return _stopEdit();
    setState(() => _saving = true);
    await save(text);
    if (mounted && identical(_editing, editing)) _stopEdit();
  }

  /// Text, or files to stand without it (backend messageEdits.ts).
  bool get _canSave =>
      (_editing?.text.trim().isNotEmpty ?? false) ||
      widget.message.attachments.isNotEmpty;

  /// The in-place editor: the text in a field, Cancel and Save. Enter saves
  /// and Shift+Enter writes another line, as in the composer; Esc cancels.
  Widget _editor(BuildContext context, TextEditingController editing) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.field,
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
          border: Border.all(color: DesktopChrome.rim),
        ),
        child: Padding(
          padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
          child: Focus(
            onKeyEvent: (_, event) {
              if (event is KeyDownEvent &&
                  event.logicalKey == LogicalKeyboardKey.escape) {
                _stopEdit();
                return KeyEventResult.handled;
              }
              switch (composerEnter(
                event,
                focused: _editFocus.hasFocus,
                value: editing.value,
              )) {
                case ComposerEnter.ignore:
                  return KeyEventResult.ignored;
                case ComposerEnter.newline:
                  insertComposerNewline(editing, (_) => setState(() {}));
                  return KeyEventResult.handled;
                case ComposerEnter.send:
                  unawaited(_saveEdit());
                  return KeyEventResult.handled;
              }
            },
            child: TextField(
              key: ValueKey('super-message-edit-${widget.message.id}'),
              controller: editing,
              focusNode: _editFocus,
              enabled: !_saving,
              minLines: 1,
              maxLines: 12,
              maxLength: kComposerMaxLength,
              keyboardType: TextInputType.multiline,
              style: SwarmType.composer(context),
              decoration: const InputDecoration(
                isCollapsed: true,
                constraints: BoxConstraints(),
                contentPadding: EdgeInsets.zero,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                counterText: '',
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ),
      ),
      const SizedBox(height: grid.AppDesktop.controlGap),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          TextButton(
            onPressed: _saving ? null : _stopEdit,
            child: const Text('Cancel'),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          FilledButton(
            key: ValueKey('super-message-edit-save-${widget.message.id}'),
            onPressed: _saving || !_canSave
                ? null
                : () => unawaited(_saveEdit()),
            child: const Text('Save'),
          ),
        ],
      ),
    ],
  );

  /// A voice message's text is its words, which are never shown or handed
  /// over: it plays only (anh Dee, 2026-11-04). It has no Copy, no ⌘C and
  /// no Edit.
  bool get _voice => superTabVoiceOf(widget.message) != null;

  Future<void> _copy() async {
    if (_voice) return;
    await Clipboard.setData(ClipboardData(text: widget.message.text));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text('Message copied'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  /// The More menu's choices, in Slack's order.
  List<SuperTabMoreAction> get _moreActions => [
    if (widget.link case final link?)
      (
        label: 'Copy link to message',
        icon: AppIcons.link2,
        onPressed: () => unawaited(_copyLink(link)),
      ),
    if (widget.onMarkUnread case final markUnread?)
      (label: 'Mark unread', icon: AppIcons.mail, onPressed: markUnread),
  ];

  /// The author's own changes, under the menu's rule.
  List<SuperTabMoreChange> get _changes => [
    if (widget.onEdit != null && !_voice)
      (
        label: 'Edit message',
        icon: AppIcons.pencil,
        onPressed: _startEdit,
        danger: false,
      ),
    if (widget.onDelete case final delete?)
      (
        label: 'Delete message',
        icon: AppIcons.trash2,
        onPressed: delete,
        danger: true,
      ),
  ];

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

  Widget _avatar(SuperTabMessage message) => superTabMessageAvatar(
    message,
    author: widget.author,
    agent: widget.agent,
    person: widget.person,
  );

  /// The sender's name: opens the agent when it is one.
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
    return InkWell(onTap: widget.onOpenAgent, child: name);
  }

  /// The reader's own message, a task line or proposal sent in their name
  /// too: drawn as their bubble on the right.
  bool get _own {
    final message = widget.message;
    return widget.readerId.isNotEmpty &&
        !message.fromAgent &&
        message.authorId == widget.readerId;
  }

  /// Whether the row has words for a bubble: its text, a note, an edit, or
  /// that it was deleted. A voice message is its own bubble.
  bool _bubbled(bool voiceMessage) {
    final message = widget.message;
    return message.deleted ||
        _editing != null ||
        message.terminalNote != null ||
        (message.text.isNotEmpty && !voiceMessage);
  }

  /// The message's full date and time, on its bubble's tooltip: the chat
  /// shows a time only after a pause.
  String get _clock {
    final time = widget.message.createdAt?.toLocal();
    if (time == null) return widget.author;
    final l10n = MaterialLocalizations.of(context);
    return '${l10n.formatFullDate(time)}, '
        '${TimeOfDay.fromDateTime(time).format(context)}';
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
    final voiceMessage = superTabVoiceOf(message) != null;
    final active = _hovered || _focused;
    // A message that tags the reader stands out, as Slack marks one that
    // names you: an accent bar on its edge over a wash of the accent.
    final taggedYou =
        widget.readerId.isNotEmpty &&
        message.mentions.contains(widget.readerId);
    // Your own bubbles sit on the right (anh Dee's mockup, 11-07, #4529).
    final own = _own;
    // Names and faces only where more than one other party speaks.
    final faces = !widget.oneOnOne && !own;
    final named = faces && !widget.grouped;
    // A phone's name is a finger tall: the gap above gives up the half that
    // would push it down.
    final phone = workspaceIsCompact(context);
    final finger = phone && named;
    final nameStyle = SwarmType.nameLine(context, color: DesktopChrome.muted);
    final slack = finger ? 12.0 : 0.0;
    // One sender's bubbles sit close; a new sender starts a group gap down.
    final above = widget.grouped
        ? SuperTabMessageRow.joinedGap
        : grid.AppDesktop.groupGap - slack;
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
                !keys.isAltPressed &&
                !_voice) {
              _copy();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: Semantics(
            container: true,
            label: named ? null : _groupedLabel,
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
                    ),
                    child: LayoutBuilder(
                      builder: (_, room) => Column(
                        crossAxisAlignment: own
                            ? CrossAxisAlignment.end
                            : CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            mainAxisAlignment: own
                                ? MainAxisAlignment.end
                                : MainAxisAlignment.start,
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              // A group chat's face sits by its sender's last
                              // bubble (anh Dee's mockup, 11-07, #4529).
                              if (faces) ...[
                                SizedBox(
                                  width: SuperTabMessageRow.avatarSize,
                                  child: widget.joinsBelow
                                      ? null
                                      : ExcludeSemantics(
                                          child: Tooltip(
                                            message: _identityDetails,
                                            child: _avatar(message),
                                          ),
                                        ),
                                ),
                                const SizedBox(
                                  width: SuperTabMessageRow.avatarGap,
                                ),
                              ],
                              // A line on its way says so beside its bubble, so
                              // the row keeps its height once it is confirmed.
                              if (widget.headerStatus case final status?) ...[
                                ConstrainedBox(
                                  // The room a bubble leaves: a long status
                                  // wraps there and never narrows the bubble.
                                  constraints: BoxConstraints(
                                    maxWidth:
                                        room.maxWidth *
                                            (1 -
                                                SuperTabMessageRow.shareOf(
                                                  own: own,
                                                )) -
                                        8,
                                  ),
                                  child: Padding(
                                    padding: const EdgeInsets.only(
                                      bottom: grid.AppDesktop.bubbleNoteGap,
                                    ),
                                    child: status,
                                  ),
                                ),
                                const SizedBox(width: 8),
                              ],
                              Flexible(
                                child: ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth:
                                        room.maxWidth *
                                        SuperTabMessageRow.shareOf(own: own),
                                  ),
                                  child: SwarmBubbleSide(
                                    own: own,
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment: own
                                          ? CrossAxisAlignment.end
                                          : CrossAxisAlignment.start,
                                      children: [
                                        if (named)
                                          Padding(
                                            padding: grid
                                                .AppDesktop
                                                .bubbleNamePadding,
                                            child: Wrap(
                                              spacing: 8,
                                              crossAxisAlignment:
                                                  WrapCrossAlignment.center,
                                              children: [
                                                _name(nameStyle, finger),
                                                if (widget.thread?.askTag
                                                    case final tag?)
                                                  Text(
                                                    tag,
                                                    style: SwarmType.time(
                                                      context,
                                                    ),
                                                  ),
                                              ],
                                            ),
                                          ),
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
                                            padding: const EdgeInsets.only(
                                              bottom: 8,
                                            ),
                                            child: SuperTabReplyPreview(
                                              author:
                                                  widget.replyAuthor ??
                                                  widget.reply?.authorName ??
                                                  'Earlier message',
                                              text: switch (widget.reply) {
                                                final reply? =>
                                                  superTabQuoteText(reply),
                                                null when widget.replyGone =>
                                                  'Original message removed',
                                                null =>
                                                  'Original message not loaded',
                                              },
                                              onTap: widget.onOpenReply == null
                                                  ? null
                                                  : () => widget.onOpenReply!(
                                                      context,
                                                    ),
                                            ),
                                          ),
                                        if (_bubbled(voiceMessage))
                                          SwarmBubble(
                                            own: own,
                                            tooltip: _clock,
                                            joinsAbove: widget.grouped,
                                            joinsBelow: widget.joinsBelow,
                                            child: Column(
                                              mainAxisSize: MainAxisSize.min,
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                if (message.terminalNote
                                                    case final note?)
                                                  Padding(
                                                    padding:
                                                        const EdgeInsets.only(
                                                          bottom: 6,
                                                        ),
                                                    child: Text(
                                                      note,
                                                      style:
                                                          DesktopChrome.metadata(),
                                                    ),
                                                  ),
                                                if (message.deleted)
                                                  Text(
                                                    SuperTabMessageRow
                                                        .deletedText,
                                                    key: ValueKey(
                                                      'super-message-deleted-${message.id}',
                                                    ),
                                                    style:
                                                        SwarmType.body(
                                                          context,
                                                          color: DesktopChrome
                                                              .muted,
                                                        ).copyWith(
                                                          fontStyle:
                                                              FontStyle.italic,
                                                        ),
                                                  )
                                                else if (_editing
                                                    case final editing?)
                                                  ConstrainedBox(
                                                    constraints:
                                                        const BoxConstraints(
                                                          maxWidth: 960,
                                                        ),
                                                    child: _editor(
                                                      context,
                                                      editing,
                                                    ),
                                                  )
                                                // A voice message's text is its words, never
                                                // shown: it plays only (anh Dee, 2026-11-04).
                                                else if (message
                                                        .text
                                                        .isNotEmpty &&
                                                    !voiceMessage)
                                                  Opacity(
                                                    opacity: widget.dimmed
                                                        ? 0.6
                                                        : 1,
                                                    child: ConstrainedBox(
                                                      constraints:
                                                          const BoxConstraints(
                                                            maxWidth: 960,
                                                          ),
                                                      // The whole message, never folded behind More (anh Dee, 2026-11-09).
                                                      child: SuperTabMessageText(
                                                        message.text,
                                                        ink: own
                                                            ? SwarmBubble.ownInk
                                                            : null,
                                                        references:
                                                            widget.references,
                                                        onOpenGroup:
                                                            widget.onOpenGroup,
                                                        mentions:
                                                            widget.mentions,
                                                        addressed: widget.to,
                                                        agents:
                                                            widget.agentNames,
                                                        addresses: widget
                                                            .mentionAddresses,
                                                        labels: widget
                                                            .mentionLabels,
                                                        taggedYou: taggedYou,
                                                      ),
                                                    ),
                                                  ),
                                                if (message.editedAt != null &&
                                                    !message.deleted &&
                                                    _editing == null)
                                                  Text(
                                                    '(edited)',
                                                    key: ValueKey(
                                                      'super-message-edited-${message.id}',
                                                    ),
                                                    style: SwarmType.time(
                                                      context,
                                                      color: own
                                                          ? SwarmBubble.ownInk
                                                          : null,
                                                    ),
                                                  ),
                                              ],
                                            ),
                                          ),
                                        if (message.attachments.isNotEmpty &&
                                            !message.deleted)
                                          Opacity(
                                            opacity: widget.dimmed ? 0.6 : 1,
                                            child: Padding(
                                              padding: EdgeInsets.only(
                                                top:
                                                    message.text.isEmpty ||
                                                        voiceMessage
                                                    ? 0
                                                    : 8,
                                              ),
                                              child: SuperTabAttachments(
                                                message.attachments,
                                                conversationId:
                                                    message.conversationId,
                                                messageId: message.id,
                                              ),
                                            ),
                                          ),
                                        if (!message.deleted) ...[
                                          SuperTabPullRequestLinks(
                                            message.text,
                                          ),
                                          if (widget.linkTarget
                                              case final resolve?)
                                            if (widget.onOpenLink
                                                case final open?)
                                              SuperTabMessageLinkPreviews(
                                                message.text,
                                                resolve: resolve,
                                                onOpen: open,
                                              ),
                                        ],
                                        ...widget.receipts,
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          // A task's replies sit under its bubble, so its face stays by the bubble (Swarm v4).
                          if ((widget.thread, widget.onOpenThread) case (
                            final thread?,
                            final open?,
                          ))
                            Padding(
                              padding: EdgeInsetsDirectional.only(
                                start: faces
                                    ? SuperTabMessageRow.avatarSize +
                                          SuperTabMessageRow.avatarGap
                                    : 0,
                              ),
                              child: SuperTabThreadLine(
                                key: ValueKey(
                                  'super-thread-line-${message.id}',
                                ),
                                thread: thread,
                                unread: widget.threadUnread,
                                onOpen: open,
                                member: widget.member,
                                trailing: widget.threadTrailing,
                                end: widget.threadEnd,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  // A deleted message has nothing left to act on, and one
                  // being edited has its own buttons.
                  if (!message.deleted && _editing == null)
                    Positioned(
                      top: 0,
                      // Away from the bubble, so they never cover it.
                      right: own ? null : 12,
                      left: own ? 12 : null,
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
                                  enabled: phone,
                                  AppIconButton(
                                    icon: AppIcons.reply,
                                    tooltip: 'Reply',
                                    onPressed: widget.onReply,
                                  ),
                                ),
                              if (!voiceMessage)
                                fingerTarget(
                                  enabled: phone,
                                  AppIconButton(
                                    icon: AppIcons.copy,
                                    tooltip: 'Copy message',
                                    onPressed: _copy,
                                  ),
                                ),
                              if ((_moreActions, _changes)
                                  case (final actions, final changes)
                                  when actions.isNotEmpty || changes.isNotEmpty)
                                fingerTarget(
                                  enabled: phone,
                                  SuperTabMessageMoreMenu(
                                    key: ValueKey(
                                      'super-message-more-${message.id}',
                                    ),
                                    actions: actions,
                                    changes: changes,
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

/// Lights a message briefly, as the one a quote was followed to, or while it
/// is find's current match; a [match] of find's others is lit more quietly.
class SuperTabMessageHighlight extends StatelessWidget {
  const SuperTabMessageHighlight({
    super.key,
    required this.on,
    this.match = false,
    required this.child,
  });
  final bool on, match;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final selection = DesktopChrome.selection;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      color: on
          ? selection
          : match
          ? selection.withValues(alpha: selection.a / 2)
          : Colors.transparent,
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
    this.member,
    this.trailing,
    this.end,
  });

  final SuperTabThread thread;

  /// Drawn after the line's link, outside it: a thread session's mark.
  final Widget? trailing;

  /// Drawn last, outside the line's link: End session.
  final Widget? end;
  final bool unread;
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
      face: kind == 'agent',
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
      label: [count, if (unread) 'unread'].join(', '),
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
