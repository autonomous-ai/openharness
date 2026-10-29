import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/app_settings.dart';
import 'package:harness_mobile/phone/composing_keyboard.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'identity.dart';
import 'model.dart';
import 'prompt_alerts.dart';
import 'swarm_attach.dart';
import 'swarm_buddy.dart';
import 'swarm_buddy_chat.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_face.dart';
import 'swarm_file_picker.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_inbox.dart';
import 'swarm_message_row.dart';
import 'swarm_need_rows.dart';
import 'swarm_profile_sheet.dart';
import 'swarm_project_page.dart';
import 'swarm_reactions.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_voice.dart';
import 'team_glance.dart';

/// Opens [conversationId] of Swarm [swarmId] over the current page.
void openSwarmConversation(
  BuildContext context,
  String swarmId,
  String conversationId,
) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmConversationPage(
        swarmId: swarmId,
        conversationId: conversationId,
      ),
      listensForItself: true,
    ),
  ),
);

/// Opens this app's page in the phone's Settings, where a refused camera is turned back on.
/// Replaced in tests, where there is no Settings to open.
@visibleForTesting
Future<bool> Function() openSwarmSettings = openAppSettings;

/// One conversation: its messages, newest at the foot, older ones on demand —
/// each with who wrote it, their role and when, follow-ups grouped, a reply's
/// quote leading to its original; the decisions asked of the person in it;
/// and, for a writer, a composer that posts text, as a reply or with
/// @mentions of the conversation's agents picked as they are typed, and with
/// files from the photo library, the camera or Files ([swarmSendsFiles]). A
/// post shows at once and says when it is not confirmed.
class SwarmConversationPage extends StatefulWidget {
  const SwarmConversationPage({
    super.key,
    required this.swarmId,
    required this.conversationId,
    this.title,
    this.subtitle,
    this.action,
    this.below,
    this.messageId,
    this.decisionId,
    this.mention,
  });

  final String swarmId, conversationId;
  final String? messageId, decisionId;

  /// An agent to @mention in the draft as the chat opens: the PM, as its
  /// private line is answered in the project chat.
  final String? mention;

  /// The header's lines in place of the chat's name and its project: a
  /// project's chat is its project's screen, under the project's name and
  /// who is in it (`swarm_project_page.dart`).
  final String? title, subtitle;

  /// At the header's end: a project's ⋮ menu. The person's own Buddy chat
  /// has its own, Remove Buddy, when this is null.
  final Widget? action;

  /// Under the header: a project's team in one line.
  final Widget? below;

  @override
  State<SwarmConversationPage> createState() => _SwarmConversationPageState();
}

class _SwarmConversationPageState extends State<SwarmConversationPage>
    with WidgetsBindingObserver {
  SwarmSession? _session;
  SwarmConversation? _conversation;
  final _text = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Swarm composer');

  /// What the last pick left out, or why it could not pick, over the files.
  final _attachNote = ValueNotifier<String?>(null);

  /// A picker is up: one at a time.
  bool _picking = false;

  /// The composer's mic, while the shell can hear one ([SwarmScope.voiceOf]).
  SwarmVoice? _voice;
  final _scroll = ScrollController();

  /// The message whose actions are open (Reply, Copy), by a tap on it.
  String? _acting;

  /// A quote followed to its original: the original being brought into view,
  /// the one lit for a moment on arrival, the search through earlier pages,
  /// and what to say when it cannot be found.
  String? _target, _lit;
  String? _decisionTarget;
  bool _noticeHandled = false;
  final _targetKey = GlobalKey();
  Timer? _litTimer;
  bool _finding = false;
  String? _note;

  /// Earlier messages are read on their own as the person nears the top;
  /// "Earlier messages" is offered only once that read failed.
  bool _loadingOlder = false, _olderFailed = false;

  /// No other screen covers this one.
  bool _visible = true;

  /// Harness is in front, as the shell counts it (resumed, or the app
  /// switcher over it).
  bool _inFront = _isInFront(WidgetsBinding.instance.lifecycleState);

  static bool _isInFront(AppLifecycleState? state) =>
      state == null ||
      state == AppLifecycleState.resumed ||
      state == AppLifecycleState.inactive;

  /// What it shows is seen: read ([SwarmConversation.shown]).
  bool get _seen => _visible && _inFront;

  bool _watching = false;

  /// What the chat draws of its Swarm's read, told to the page only when
  /// something drawn changed ([_ChatView]).
  final _view = ValueNotifier<_ChatView?>(null);

  /// The newest message shown when the person began reading back: those
  /// after it wait below, so what they read stays where it is, and the pill
  /// says how many. Null at the foot.
  final _held = ValueNotifier<String?>(null);

  /// Each entry's row as last built, with what it was built from ([_row]).
  final _rows = <String, ({Object inputs, Widget row})>{};

  /// What [_shown] was made from; the messages by id, and each entry's
  /// place in [_shown] by its key.
  Object? _madeFrom;
  var _byId = <String, SuperTabMessage>{};
  var _placeOf = <String, int>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _text.addListener(_typed);
    _scroll.addListener(_scrolled);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _inFront = _isInFront(state);
    _conversation?.shown = _seen;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Off while a screen pushed over this one covers it.
    _visible = TickerMode.valuesOf(context).enabled;
    _conversation?.shown = _seen;
    if (_voice == null) {
      if (SwarmScope.voiceOf(context) case final create?) {
        _voice = SwarmVoice(
          create: create,
          dictation: SwarmScope.dictationOf(context),
          draft: () => _conversation?.draft ?? '',
          write: (text) => _conversation?.draft = text,
          send: _spoken,
        );
      }
    }
    // A covered chat hears nothing: its take goes with it.
    if (!_visible) _voice?.hide();
    final session = SwarmScope.of(context);
    if (session == _session) {
      _watch();
      return;
    }
    _close();
    _session = session?..enter();
    session?.inbox.addListener(_attach);
    _attach(rebuild: false);
  }

  /// Opens the conversation once its Swarm has been read: at once, or when
  /// the account's Swarms are first read — a notice tapped at launch opens
  /// this page before then. Until then the chat is a skeleton, or not open
  /// once the Swarms read do not have its own.
  void _attach({bool rebuild = true}) {
    final session = _session;
    if (session == null || _conversation != null) return;
    final reader = session.inbox.reader(widget.swarmId);
    if (reader == null) {
      if (rebuild && mounted) setState(() {});
      return;
    }
    session.inbox.removeListener(_attach);
    // Set before what the chat kept is shown, so it is read only as far as
    // it is seen: opened at a message, through it until the person goes
    // down to the foot.
    final c = _conversation = SwarmConversation(
      reader,
      widget.conversationId,
      shown: _seen,
      heldAt: widget.messageId ?? _held.value,
    );
    c.composer.addListener(_drafted);
    if (widget.mention case final agentId?) c.mention(agentId);
    reader.addListener(_see);
    session.inbox.addListener(_see);
    _see();
    _watch();
    unawaited(
      c.load().then((_) {
        if (!mounted || _conversation != c || _noticeHandled) return;
        if (widget.messageId case final messageId?) {
          _noticeHandled = true;
          unawaited(_jumpTo(c, messageId));
        }
      }),
    );
    if (rebuild && mounted) setState(() {});
  }

  /// Its Swarm is watched while the chat is open and visible, so it is read
  /// every few seconds only then ([SwarmSession.watch]).
  void _watch() {
    final watch = _conversation != null && _visible;
    if (watch == _watching) return;
    _watching = watch;
    if (watch) {
      _session?.watch(widget.swarmId);
    } else {
      _session?.unwatch(widget.swarmId);
    }
  }

  /// The chat's [_ChatView] made again from what its Swarm's read and asks
  /// say now.
  void _see() {
    final session = _session, c = _conversation;
    if (session == null || c == null) return;
    final view = _view.value = _ChatView.of(session, c, _view.value);
    _seeBuddy(c, view.buddyProject);
    final decisionId = widget.decisionId;
    if (!_noticeHandled &&
        decisionId != null &&
        _view.value!.decisions.any((need) => need.decision.id == decisionId)) {
      _noticeHandled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _conversation != c) return;
        setState(() => _decisionTarget = decisionId);
        _reveal(c, decisionId, 0);
      });
    }
  }

  /// What the person does to their Buddy from its chat, while this is their
  /// own Buddy chat in [project] ([SwarmBuddyActions]).
  SwarmBuddyActions? _buddy;

  void _seeBuddy(SwarmConversation c, String? project) {
    final kept = _buddy;
    if (kept?.reader == c.reader && kept?.projectId == project) return;
    kept?.dispose();
    _buddy = project == null ? null : SwarmBuddyActions(c.reader, project);
  }

  void _close() {
    final session = _session;
    session?.inbox
      ?..removeListener(_attach)
      ..removeListener(_see);
    if (_conversation case final c?) {
      c.composer.removeListener(_drafted);
      c.reader.removeListener(_see);
      c.dispose();
    }
    _buddy?.dispose();
    _buddy = null;
    _rows.clear();
    _madeFrom = null;
    if (_watching) session?.unwatch(widget.swarmId);
    _watching = false;
    _conversation = null;
    session?.leave();
    _session = null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _close();
    _voice?.dispose();
    _view.dispose();
    _held.dispose();
    _litTimer?.cancel();
    _text.dispose();
    _focus.dispose();
    _attachNote.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// What the person typed, into the draft.
  void _typed() {
    final c = _conversation;
    if (c != null && c.draft != _text.text) c.draft = _text.text;
  }

  /// The draft changed under the field — a mention added, a post sent.
  void _drafted() {
    final draft = _conversation?.draft;
    if (draft == null || draft == _text.text) return;
    _text.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  /// The second tap on the mic ended a take: what is in the box goes, as Send
  /// would send it. Nothing when the box is empty, the chat is covered, or a
  /// post is already on its way.
  void _spoken() {
    final c = _conversation;
    if (c == null || !_visible || c.draft.trim().isEmpty || !c.canSend) return;
    _send(c);
  }

  /// The composer's +: the sheet, then the picker it names, its files into
  /// [c]'s. A refusal of the camera or photos offers the phone's Settings.
  Future<void> _pickFiles(SwarmConversation c) async {
    if (_picking) return;
    _picking = true;
    try {
      final source = await showSwarmAttachSheet(context);
      if (source == null || !mounted || _conversation != c) return;
      final outcome = await addSwarmPicked(
        c.files,
        source,
        stillWanted: () => mounted && _conversation == c,
      );
      if (!mounted || _conversation != c) return;
      switch (outcome) {
        case SwarmPicked(:final note):
          _attachNote.value = note;
        case SwarmPickFailed(:final message):
          _attachNote.value = message;
        case SwarmPickDenied(:final source):
          _attachNote.value = null;
          if (await showSwarmAccessOff(context, source)) {
            unawaited(openSwarmSettings());
          }
      }
    } finally {
      _picking = false;
    }
  }

  /// How far up the chat the person reads back, past which a message that
  /// arrives waits below instead of pushing up what they read.
  static const _readingBack = 48.0;

  void _scrolled() {
    _nearTop();
    if (!_scroll.hasClients) return;
    final back = _scroll.offset > _readingBack;
    // At the foot all is seen; reading back, only what was seen at the foot
    // before, or the message a notice opened the chat at.
    if (_conversation case final c?) {
      if (!back) {
        c.heldAt = null;
      } else {
        c.heldAt ??= c.messages.lastOrNull?.id;
      }
    }
    if (back == (_held.value != null)) return;
    _held.value = back ? _conversation?.messages.lastOrNull?.id : null;
  }

  /// How close to the oldest message shown the earlier ones start to be
  /// read: a screen's height ahead, so they are there before the person is.
  void _nearTop() {
    final c = _conversation;
    if (c == null ||
        !c.hasOlder ||
        _loadingOlder ||
        _olderFailed ||
        _finding ||
        !_scroll.hasClients) {
      return;
    }
    final position = _scroll.position;
    // The list runs from the foot: what is after the view is above it.
    if (position.extentAfter < position.viewportDimension) {
      unawaited(_loadOlder(c));
    }
  }

  /// Reads the page before the oldest message shown. The list is drawn from
  /// its foot, so what arrives above leaves what the person reads in place.
  Future<void> _loadOlder(SwarmConversation c) async {
    if (_loadingOlder || !c.hasOlder) return;
    setState(() {
      _loadingOlder = true;
      _olderFailed = false;
    });
    final shown = c.messages.length;
    await c.loadOlder();
    if (!mounted || _conversation != c) return;
    setState(() {
      _loadingOlder = false;
      // A read that failed, or brought nothing new while more is said to be
      // there, is not tried again on its own: it would be read over and over.
      _olderFailed =
          c.hasOlder && (c.error != null || c.messages.length == shown);
    });
  }

  /// Sends the draft, back at the foot of the chat where the post shows.
  void _send(SwarmConversation c) {
    _target = null;
    _attachNote.value = null;
    if (_scroll.hasClients && _scroll.offset > 0) {
      unawaited(
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        ),
      );
    }
    unawaited(_post(c));
  }

  /// Sends [c]'s draft, or its post not confirmed again. Once the backend
  /// took it the keyboard goes down, unless the next message is already being
  /// typed; a post refused or not confirmed keeps it up, to send again.
  Future<void> _post(SwarmConversation c) async {
    final sent = await c.send();
    if (sent && mounted && _conversation == c && c.draft.isEmpty) {
      _focus.unfocus();
    }
  }

  void _reply(SwarmConversation c, SuperTabMessage message) {
    c.replyingTo = message;
    setState(() => _acting = null);
    _focus.requestFocus();
  }

  /// How many earlier pages a quote's original is looked for in: as many as
  /// a tag opens through on the desktop.
  static const _findPages = 50;

  /// Brings [messageId] into view and lights it — read in from earlier pages
  /// when it is further back — or says why it cannot.
  Future<void> _jumpTo(SwarmConversation c, String messageId) async {
    if (_finding) return;
    setState(() {
      _decisionTarget = null;
      _finding = true;
      _note = null;
    });
    // Read back page by page with no redraw between them: the chat is drawn
    // once, with the original among the messages.
    final found = await c.readBackTo(messageId, pages: _findPages);
    if (!mounted || _conversation != c) return;
    setState(() {
      _finding = false;
      _note = found
          ? null
          : c.error != null
          ? "Couldn't read the original message. Try again."
          : c.hasOlder
          ? 'The original message is too far back.'
          : 'The original message is no longer in this chat.';
      if (found) _target = messageId;
    });
    if (!found) {
      // Nothing to read back to: at the foot, all is seen.
      if (!_scroll.hasClients || _scroll.offset <= _readingBack) {
        c.heldAt = null;
      }
      return;
    }
    _reveal(c, messageId, 0);
    _litTimer?.cancel();
    setState(() => _lit = messageId);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
  }

  /// The list builds only the rows near what is shown: it jumps near the
  /// target by its place in the list until its row is built, then brings it
  /// to the middle (the desktop's `_revealTarget`).
  void _reveal(SwarmConversation c, String messageId, int attempt) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || (_target != messageId && _decisionTarget != messageId)) {
        return;
      }
      if (_targetKey.currentContext case final row?) {
        unawaited(
          Scrollable.ensureVisible(
            row,
            alignment: 0.5,
            duration: const Duration(milliseconds: 250),
          ),
        );
        return;
      }
      final shown = _shown;
      final index = shown.indexWhere(
        (entry) => _decisionTarget == messageId
            ? entry is _AskEntry && entry.need.decision.id == messageId
            : entry is _MessageEntry && entry.message.id == messageId,
      );
      if (!_scroll.hasClients || index < 0 || attempt > 20) return;
      final position = _scroll.position;
      position.jumpTo(
        (position.maxScrollExtent * (index + 1) / shown.length).clamp(
          0,
          position.maxScrollExtent,
        ),
      );
      _reveal(c, messageId, attempt + 1);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// What the list draws, newest first: kept for [_reveal] to find a row's
  /// place by.
  List<_Entry> _shown = const [];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    final c = _conversation;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: session == null
            ? Align(
                alignment: Alignment.topLeft,
                child: TtyBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              )
            : c == null
            ? _unopened(context, session, tty)
            : ValueListenableBuilder(
                valueListenable: _view,
                builder: (context, view, _) =>
                    _page(context, session, c, view!, tty),
              ),
      ),
    );
  }

  /// Before the account's Swarms are read: a skeleton under a placeholder
  /// header — or, once they are read without this chat's Swarm, not open.
  Widget _unopened(BuildContext context, SwarmSession session, Tty tty) {
    final inbox = session.inbox;
    final error = inbox.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _header(
          context,
          tty,
          title: widget.title ?? (inbox.loaded ? 'Chat' : null),
          project: widget.subtitle,
          action: widget.action,
        ),
        ?widget.below,
        Expanded(
          child: inbox.loaded
              ? _said(_notOpen)
              : error != null
              ? _said(error)
              : const _ChatSkeleton(),
        ),
      ],
    );
  }

  static const _notOpen = 'This chat is not open to you.';

  /// What the chat says in place of its messages.
  Widget _said(String text, {Key? key}) => Padding(
    padding: const EdgeInsets.all(Tty.origin),
    child: Text(
      text,
      key: key,
      style: swarmChatText(15, color: AppPalette.textSecondary),
    ),
  );

  /// The back button, then the chat's name and its project under it — or,
  /// while the chat is not known yet ([title] null), placeholders of their
  /// size — and [action] at its end.
  Widget _header(
    BuildContext context,
    Tty tty, {
    required String? title,
    String? project,
    Widget? action,
  }) => Padding(
    key: const ValueKey('swarm-chat-header'),
    padding: const EdgeInsets.fromLTRB(0, AppSpace.xs, _headerEnd, AppSpace.xs),
    child: Row(
      children: [
        TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
        Expanded(
          child: title == null
              ? Column(
                  key: const ValueKey('swarm-header-placeholder'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SkeletonText(
                      style: tty.style(
                        size: TtySize.title,
                        weight: FontWeight.w600,
                      ),
                      width: 140,
                    ),
                    SkeletonText(style: swarmChatText(13), width: 72),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      key: const ValueKey('swarm-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: tty.style(
                        size: TtySize.title,
                        weight: FontWeight.w600,
                      ),
                    ),
                    if (project != null)
                      Text(
                        project,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: swarmChatText(
                          13,
                          color: AppPalette.textSecondary,
                        ),
                      ),
                  ],
                ),
        ),
        // The screen's side margin from its edge: the header's own end
        // inset, and the rest of the margin.
        if (action != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: AppSpace.s,
              end: AppSpace.screenInset - _headerEnd,
            ),
            child: action,
          ),
      ],
    ),
  );

  /// The header's inset at its end.
  static const _headerEnd = AppSpace.s;

  /// The header and the composer follow [view] — the header [c] too, until
  /// the chat is known; the messages, and what is said under them, follow
  /// [c]; the composer follows what is typed.
  Widget _page(
    BuildContext context,
    SwarmSession session,
    SwarmConversation c,
    _ChatView view,
    Tty tty,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      // Placeholders until the chat is known, unless it is not open.
      ListenableBuilder(
        listenable: c,
        builder: (context, _) => _header(
          context,
          tty,
          title:
              widget.title ??
              (view.known || c.state == SwarmChatState.lost
                  ? view.title
                  : null),
          project: widget.subtitle ?? view.project,
          // The person's own Buddy chat: Remove Buddy.
          action:
              widget.action ??
              switch (_buddy) {
                final buddy? => SwarmBuddyMenuButton(actions: buddy),
                null => null,
              },
        ),
      ),
      ?widget.below,
      if (_buddy case final buddy?) SwarmBuddyBar(actions: buddy),
      Expanded(
        child: Stack(
          children: [
            Positioned.fill(
              child: ListenableBuilder(
                listenable: Listenable.merge([c, _held]),
                builder: (context, _) =>
                    _messages(context, session, c, view, tty),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 8,
              child: ListenableBuilder(
                listenable: Listenable.merge([c, _held]),
                builder: (context, _) => switch (_waiting(c)) {
                  0 => const SizedBox.shrink(),
                  final count => Center(
                    child: _NewPill(count: count, onTap: _toFoot),
                  ),
                },
              ),
            ),
          ],
        ),
      ),
      ListenableBuilder(
        listenable: c,
        builder: (context, _) {
          final note = _finding ? 'Finding the original message…' : _note;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (note != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpace.screenInset,
                    AppSpace.s,
                    AppSpace.screenInset,
                    0,
                  ),
                  child: Text(
                    note,
                    key: const ValueKey('swarm-find-note'),
                    style: swarmChatText(13.5, color: AppPalette.textSecondary),
                  ),
                ),
              // Unless the body says it already: not open, or no conversation
              // and nothing read.
              if (c.error case final error?
                  when c.state != SwarmChatState.lost &&
                      (view.known || c.messages.isNotEmpty))
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpace.screenInset,
                    AppSpace.s,
                    AppSpace.screenInset,
                    0,
                  ),
                  child: Text(
                    error,
                    key: const ValueKey('swarm-post-error'),
                    style: swarmChatText(13.5, color: tty.red),
                  ),
                ),
            ],
          );
        },
      ),
      if (view.canPost)
        ListenableBuilder(
          listenable: Listenable.merge([c.composer, _voice]),
          builder: (context, _) => _composer(c, tty, hint: view.hint),
        )
      else if (view.known)
        Padding(
          padding: const EdgeInsets.all(AppSpace.l),
          child: Text(
            view.archived
                ? 'This chat is archived.'
                : 'You can read this chat, not post in it.',
            key: const ValueKey('swarm-read-only'),
            style: swarmChatText(13.5, color: AppPalette.textSecondary),
          ),
        ),
    ],
  );

  /// Opens [projectId]'s chat with [pmId] mentioned in its draft: the PM's
  /// private line answered where the PM reads, and everyone with it.
  void _answerIn(String projectId, String pmId) => unawaited(
    Navigator.of(context).push(
      phoneRoute(
        (_) => SwarmProjectPage(
          swarmId: widget.swarmId,
          projectId: projectId,
          mention: pmId,
        ),
        listensForItself: true,
      ),
    ),
  );

  /// [m]'s author as a quote names them: the person's own messages are
  /// "You".
  String _quoted(SwarmConversation c, SuperTabMessage m) =>
      !m.fromAgent && m.authorId == c.reader.accountId ? 'You' : _nameOf(c, m);

  /// [m]'s author by name; in the person's own Buddy chat the PM's private
  /// lines read as lines to them, "River (PM) → you": the PM writes there but
  /// cannot read it (#2090).
  String _nameOf(SwarmConversation c, SuperTabMessage m) {
    final name = c.reader.snapshot?.authorName(m) ?? m.authorName;
    return swarmIsPmLine(c.reader, m) ? '$name (PM) → you' : name;
  }

  SwarmLook _lookOf(SwarmConversation c, SuperTabMessage m) =>
      c.reader.snapshot?.authorLook(m) ?? (picture: null, status: null);

  static SwarmLook _agentLook(SuperTabAgent? agent) =>
      (picture: agent?.avatar, status: null);

  /// Who gave a reaction, by name and never by email: "You", an agent's
  /// name, another person's email name.
  String _reactorName(SwarmConversation c, String kind, String id) {
    if (kind == 'person' && id == c.reader.accountId) return 'You';
    final snapshot = c.reader.snapshot;
    if (kind == 'agent') return snapshot?.agentName(id) ?? 'Agent';
    final email = snapshot?.people.where((p) => p.id == id).firstOrNull?.email;
    return email == null ? 'Someone' : superTabPersonName(email);
  }

  /// The reaction picker over message [id]: the pick reacts to the message
  /// as it is by then.
  Future<void> _pickReaction(SwarmConversation c, String id) async {
    SuperTabMessage? shown() => c.messages.where((m) => m.id == id).firstOrNull;
    final message = shown();
    if (message == null) return;
    final emoji = await showSwarmReactionPicker(
      context,
      reactions: c.reactionsOf(message),
      readerId: c.reader.accountId,
    );
    if (emoji == null || !mounted) return;
    if (shown() case final now?) await c.react(now, emoji);
  }

  /// The messages, newest at the foot, with the decisions asked among them.
  /// The entries are made again only when what they are made from changed,
  /// and each row is the one built before while it draws the same ([_row]):
  /// a new message builds its own row alone.
  ///
  /// Until the first page is read, skeleton bubbles; "not open" only once
  /// the backend refused the chat; a chat read with nothing in it says so.
  Widget _messages(
    BuildContext context,
    SwarmSession session,
    SwarmConversation c,
    _ChatView view,
    Tty tty,
  ) {
    final state = c.state;
    if (state == SwarmChatState.lost) return _said(c.error ?? _notOpen);
    if (c.messages.isEmpty && c.pending == null) {
      if (state != SwarmChatState.loaded) {
        // A first read that failed: said under the chat once it is known,
        // here until then.
        if (c.error case final error?) {
          return view.known ? const SizedBox.shrink() : _said(error);
        }
        return const _ChatSkeleton();
      }
      if (view.decisions.isEmpty) {
        return _said(
          'No messages yet.',
          key: const ValueKey('swarm-chat-empty'),
        );
      }
    }
    final snapshot = c.reader.snapshot;
    final answered = answeredPromptAlerts(
      c.messages,
      (agentId) => snapshot?.agent(agentId),
    );
    final messages = answered.isEmpty
        ? c.messages
        : [
            for (final m in c.messages)
              if (!answered.contains(m.id)) m,
          ];
    // The notes hidden are part of what the rows were made from: a warning
    // goes once its agent's prompt is answered, with no new message.
    final from = (
      c.messages,
      view.decisions,
      c.hasOlder,
      _held.value,
      answered.join(','),
    );
    if (from != _madeFrom) {
      // Read back: the messages after the newest shown then wait below, and
      // so do decisions asked after it.
      final held = _held.value;
      final at = held == null
          ? -1
          : messages.lastIndexWhere((m) => m.id == held);
      final shown = at < 0 ? messages : messages.sublist(0, at + 1);
      final last = shown.lastOrNull?.createdAt;
      final asks = at < 0 || last == null
          ? view.decisions
          : [
              for (final need in view.decisions)
                if (!(need.decision.createdAt?.isAfter(last) ?? false)) need,
            ];
      _shown = _timeline(shown, asks, hasOlder: c.hasOlder).reversed.toList();
      _byId = {for (final m in c.messages) m.id: m};
      _placeOf = {for (final (i, entry) in _shown.indexed) _keyOf(entry): i};
      _rows.removeWhere((key, _) => !_placeOf.containsKey(key));
      _madeFrom = from;
    }
    final entries = _shown;
    final byId = _byId;
    final pending = c.pending;
    // A page shorter than the screen never scrolls: look once it is drawn.
    if (c.hasOlder && !_loadingOlder && !_olderFailed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _nearTop();
      });
    }
    final lead = pending == null ? 0 : 1;

    Widget entry(_Entry entry) {
      final key = _keyOf(entry);
      switch (entry) {
        case _DayEntry(:final day):
          final today = DateUtils.dateOnly(DateTime.now());
          return _row(key, (day, today), () => _Day(day: day, today: today));
        case _MessageEntry(message: final m, :final grouped):
          final reply = m.replyTo == null ? null : byId[m.replyTo];
          final name = _nameOf(c, m);
          final look = _lookOf(c, m);
          final pm = swarmIsPmLine(c.reader, m);
          // "River (PM) → you" says the role already.
          final role = m.fromAgent && !pm ? view.roles[m.authorId] : null;
          // The PM cannot read this chat: its line is answered in the
          // project chat, where everyone reads it (Tony, mockup A, 10-29).
          final answerIn = pm && view.canPost ? view.buddyProject : null;
          final quoted = reply == null ? null : _quoted(c, reply);
          final lit = _lit == m.id, followed = _target == m.id;
          final acting = _acting == m.id;
          final reactions = c.reactionsOf(m);
          return _row(
            key,
            (
              m,
              name,
              swarmLookKey(look),
              role,
              grouped,
              lit,
              followed,
              acting,
              reply,
              quoted,
              view.canPost,
              view.mentions,
              reactions,
              answerIn,
              view.project,
            ),
            () => SwarmMessageRow(
              key: followed ? _targetKey : null,
              message: m,
              name: name,
              look: look,
              role: role,
              mentions: view.mentions,
              grouped: grouped,
              lit: lit,
              followed: followed,
              quote: m.replyTo == null
                  ? null
                  : SwarmQuote(
                      key: ValueKey('swarm-quote-${m.id}'),
                      author: quoted,
                      text: reply?.text,
                      onTap: () => unawaited(_jumpTo(c, m.replyTo!)),
                    ),
              actions: acting,
              onTap: () =>
                  setState(() => _acting = _acting == m.id ? null : m.id),
              onReply: view.canPost ? () => _reply(c, m) : null,
              onAuthor: m.fromAgent
                  ? null
                  : () => unawaited(
                      showSwarmPerson(
                        context,
                        swarmId: widget.swarmId,
                        personId: m.authorId,
                      ),
                    ),
              reactions: SwarmReactionBar(
                messageId: m.id,
                reactions: reactions,
                readerId: c.reader.accountId,
                nameOf: (kind, id) => _reactorName(c, kind, id),
                onReact: view.canPost
                    ? (emoji) => unawaited(c.react(m, emoji))
                    : null,
              ),
              onLongPress: view.canPost
                  ? () => unawaited(_pickReaction(c, m.id))
                  : null,
              below: answerIn == null
                  ? null
                  : _AnswerIn(
                      key: ValueKey('swarm-answer-in-${m.id}'),
                      project: view.project ?? 'the project chat',
                      onTap: () => _answerIn(answerIn, m.authorId),
                    ),
            ),
          );
        case _AskEntry(:final need, :final grouped):
          final asker = snapshot == null ? null : swarmAsker(snapshot, need);
          final role = asker == null ? null : view.roles[asker.id];
          return _row(
            key,
            (
              need,
              grouped,
              asker?.id,
              role,
              swarmLookKey(_agentLook(asker)),
              _decisionTarget == need.decision.id,
            ),
            () => KeyedSubtree(
              key: _decisionTarget == need.decision.id ? _targetKey : null,
              child: _Ask(
                session: session,
                need: need,
                grouped: grouped,
                askerId: asker?.id,
                role: role,
                picture: asker?.avatar,
              ),
            ),
          );
      }
    }

    return ListView.builder(
      key: const ValueKey('swarm-messages'),
      controller: _scroll,
      reverse: true,
      padding: _listPadding,
      itemCount: lead + entries.length + (c.hasOlder ? 1 : 0),
      // A row keeps its element when a message or a post moves the others'
      // places.
      findChildIndexCallback: (key) {
        if (key is! ValueKey<String>) return null;
        if (key.value == _pendingKey) return lead == 1 ? 0 : null;
        if (key.value == _olderKey) {
          return c.hasOlder ? lead + entries.length : null;
        }
        final at = _placeOf[key.value];
        return at == null ? null : lead + at;
      },
      itemBuilder: (context, index) {
        if (index < lead) {
          final reply = pending!.replyTo == null ? null : byId[pending.replyTo];
          final mine = c.messages.reversed
              .where((m) => !m.fromAgent && m.authorId == c.reader.accountId)
              .firstOrNull;
          return _Pending(
            key: const ValueKey(_pendingKey),
            name: mine == null ? 'You' : _nameOf(c, mine),
            look:
                c.reader.snapshot?.personLook(c.reader.accountId) ??
                (picture: null, status: null),
            text: pending.text,
            files: pending.files,
            mentions: view.mentions,
            sending: c.sending,
            quote: pending.replyTo == null
                ? null
                : SwarmQuote(
                    author: reply == null ? null : _quoted(c, reply),
                    text: reply?.text,
                  ),
            onSendAgain: () => unawaited(_post(c)),
          );
        }
        if (index - lead < entries.length) {
          return entry(entries[index - lead]);
        }
        // Read on their own near the top, behind skeleton bubbles; the link
        // only once that read failed.
        return KeyedSubtree(
          key: const ValueKey(_olderKey),
          child: _olderFailed
              ? Center(
                  child: _Link(
                    key: const ValueKey('swarm-older-messages'),
                    label: 'Earlier messages',
                    onTap: () => unawaited(_loadOlder(c)),
                  ),
                )
              : Semantics(
                  label: 'Loading earlier messages',
                  child: const Column(
                    key: ValueKey('swarm-older-loading'),
                    children: [
                      _SkeletonBubble(lines: 2, width: 0.7),
                      _SkeletonBubble(lines: 1, width: 0.45),
                    ],
                  ),
                ),
        );
      },
    );
  }

  static const _pendingKey = 'swarm-row-pending', _olderKey = 'swarm-row-older';

  /// The key a row of [entry] keeps wherever it moves in the list.
  static String _keyOf(_Entry entry) => switch (entry) {
    _DayEntry(:final day) => 'swarm-row-day-${day.toIso8601String()}',
    _MessageEntry(:final message) => 'swarm-row-m-${message.id}',
    _AskEntry(:final need) => 'swarm-row-${need.key}',
  };

  /// [key]'s row as built from [inputs]: the one built before while they are
  /// the same — a widget given again as it was is not built again — else a
  /// new one from [build].
  Widget _row(String key, Object inputs, Widget Function() build) {
    final kept = _rows[key];
    if (kept != null && kept.inputs == inputs) return kept.row;
    final row = KeyedSubtree(key: ValueKey(key), child: build());
    _rows[key] = (inputs: inputs, row: row);
    return row;
  }

  /// How many messages wait below while the person reads back.
  int _waiting(SwarmConversation c) {
    final held = _held.value;
    if (held == null) return 0;
    final at = c.messages.lastIndexWhere((m) => m.id == held);
    return at < 0 ? 0 : c.messages.length - at - 1;
  }

  /// Back to the foot, where the messages that waited show.
  void _toFoot() {
    if (!_scroll.hasClients) return;
    unawaited(
      _scroll.animateTo(
        0,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      ),
    );
  }

  /// The @ picker while a name is typed, the reply bar while the draft
  /// answers a message, what the last pick left out, the files going with the
  /// post, what the mic could not hear, then +, a field that grows with what
  /// is typed, the mic and a round Send. An @ is typed in the field: it has no
  /// button of its own.
  Widget _composer(SwarmConversation c, Tty tty, {required String hint}) {
    final snapshot = c.reader.snapshot;
    final query = c.mentionQuery;
    final replying = c.replyingTo;
    // One post at a time: one not confirmed is sent again from where it shows.
    // Files alone are a post too.
    final canSend = c.canSend;
    return Container(
      decoration: BoxDecoration(
        color: Color.alphaBlend(tty.text.withValues(alpha: 0.02), tty.ground),
        border: Border(top: BorderSide(color: swarmChatHair(tty))),
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.s,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (query != null && snapshot != null)
            _MentionPicker(
              agents: c.mentionable,
              snapshot: snapshot,
              query: query,
              onPick: (agent) {
                c.completeMention(agent.id);
                _focus.requestFocus();
              },
            ),
          if (replying != null)
            Padding(
              key: const ValueKey('swarm-reply-bar'),
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                0,
                0,
                AppSpace.xs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.only(left: AppSpace.s),
                      decoration: BoxDecoration(
                        border: Border(
                          left: BorderSide(
                            color: AppPalette.textFaint,
                            width: 3,
                          ),
                        ),
                      ),
                      child: Text.rich(
                        TextSpan(
                          children: [
                            const TextSpan(text: 'Reply to '),
                            TextSpan(
                              text: _quoted(c, replying) == 'You'
                                  ? 'you'
                                  : _quoted(c, replying),
                              style: TextStyle(color: AppPalette.textPrimary),
                            ),
                            TextSpan(
                              text:
                                  ': ${replying.text.replaceAll(RegExp(r'\s+'), ' ')}',
                            ),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: swarmChatText(
                          13.5,
                          color: AppPalette.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  _Round(
                    key: const ValueKey('swarm-reply-cancel'),
                    label: 'Cancel reply',
                    onTap: () => c.replyingTo = null,
                    child: Icon(
                      LucideIcons.x,
                      size: 18,
                      color: AppPalette.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ValueListenableBuilder(
            valueListenable: _attachNote,
            builder: (context, note, _) => note == null
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpace.xs,
                      0,
                      AppSpace.xs,
                      AppSpace.s,
                    ),
                    child: Text(
                      note,
                      key: const ValueKey('swarm-attach-note'),
                      style: AppType.caption(color: tty.yellow),
                    ),
                  ),
          ),
          if (_voice?.notice case final notice?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                0,
                AppSpace.xs,
                AppSpace.s,
              ),
              child: Text(
                notice,
                key: const ValueKey('swarm-voice-note'),
                style: AppType.caption(color: tty.yellow),
              ),
            ),
          // Quiet: nothing went wrong, the words stay in the box.
          if (_voice?.stopped case final stopped?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                0,
                AppSpace.xs,
                AppSpace.s,
              ),
              child: Text(
                stopped,
                key: const ValueKey('swarm-voice-stopped'),
                style: AppType.caption(color: AppPalette.textSecondary),
              ),
            ),
          SwarmOutgoingChips(conversation: c),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (swarmSendsFiles)
                _Round(
                  key: const ValueKey('swarm-attach'),
                  label: 'Attach files',
                  onTap: c.uploading || c.files.room <= 0
                      ? null
                      : () => unawaited(_pickFiles(c)),
                  child: Icon(
                    LucideIcons.plus,
                    size: AppIconSize.standalone,
                    color: c.uploading || c.files.room <= 0
                        ? AppPalette.textFaint
                        : AppPalette.textSecondary,
                  ),
                ),
              const SizedBox(width: 6),
              Expanded(
                child: _MessageField(
                  controller: _text,
                  focus: _focus,
                  hint: hint,
                ),
              ),
              if (_voice case final voice?)
                SwarmVoiceMic(voice: voice)
              else
                const SizedBox(width: 6),
              _Round(
                key: const ValueKey('swarm-send'),
                label: 'Send',
                fill: canSend ? AppPalette.accent : ttyRaised(tty),
                onTap: canSend ? () => _send(c) : null,
                child: Icon(
                  LucideIcons.arrowUp,
                  size: 20,
                  color: canSend ? AppInk.onFill : AppPalette.textFaint,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// What the chat draws of its Swarm's read and of what is asked of the
/// person in it: its header, whether they can post, the names an @mention is
/// marked for, each agent's role and the decisions open in it. Made again at
/// each read and equal to the one before when nothing drawn changed, so a read
/// that moved nothing here draws nothing again.
@immutable
class _ChatView {
  const _ChatView({
    required this.known,
    required this.title,
    required this.project,
    required this.canPost,
    required this.archived,
    required this.names,
    required this.mentions,
    required this.roles,
    required this.mentionable,
    required this.decisions,
    required this.buddyProject,
    required this.hint,
  });

  /// [c] as its Swarm's read and asks have it now. The decisions of [before]
  /// are kept while each still draws the same.
  factory _ChatView.of(
    SwarmSession session,
    SwarmConversation c,
    _ChatView? before,
  ) {
    final reader = c.reader;
    final snapshot = reader.snapshot;
    final group = c.conversation;
    final agents = snapshot?.agents ?? const <SuperTabAgent>[];
    final names = [for (final agent in agents) snapshot!.agentName(agent.id)];
    // The person's own Buddy chat (#2090): named after their Buddy, and
    // holding every question the PM asked them in its project, as on Desktop.
    final buddyProject = group != null && swarmIsOwnBuddyChat(reader, group.id)
        ? group.projectId
        : null;
    final buddy = buddyProject == null
        ? null
        : swarmBuddyName(reader, buddyProject);
    final project = snapshot?.projects
        .where((p) => p.id == group?.projectId)
        .firstOrNull
        ?.name;
    // A chat not open to the person shows none of its questions either, even
    // while the decisions read has not caught up.
    final decisions = [
      for (final need in session.inbox.needs)
        if (group != null &&
            need is SwarmDecisionNeed &&
            need.swarmId == reader.tabId &&
            (need.conversationId == c.id ||
                (buddyProject != null &&
                    need.decision.projectId == buddyProject)))
          need,
    ];
    return _ChatView(
      known: group != null,
      title: group == null ? 'Chat' : buddy ?? group.label,
      project: buddy != null && project != null ? '#$project' : project,
      canPost: c.canPost,
      archived: group?.archived ?? false,
      names: names,
      mentions: before != null && listEquals(before.names, names)
          ? before.mentions
          : SwarmMentions(names),
      roles: {
        for (final agent in agents)
          agent.id: ?swarmAgentRole(snapshot!, agent.id),
      },
      mentionable: [for (final agent in c.mentionable) agent.id],
      decisions: before != null && _sameAsks(before.decisions, decisions)
          ? before.decisions
          : List.unmodifiable(decisions),
      buddyProject: buddyProject,
      // "Message Wren"; plain while no Buddy runs to read it.
      hint: buddyProject != null && swarmBuddy(reader, buddyProject) != null
          ? 'Message $buddy'
          : 'Message',
    );
  }

  /// The conversation is in the Swarm's read.
  final bool known;
  final String title;
  final String? project;
  final bool canPost, archived;

  /// The Swarm's agents by name, and the @mentions of them marked in
  /// messages: made again only when a name changed.
  final List<String> names;
  final SwarmMentions mentions;

  /// Each agent's compact role, by agent id: PM, Dev or Rev.
  final Map<String, String> roles;

  /// The agents a post can mention, by id.
  final List<String> mentionable;
  final List<SwarmDecisionNeed> decisions;

  /// The project whose Buddy chat of the person's own this is; null for any
  /// other chat.
  final String? buddyProject;

  /// What the empty composer says.
  final String hint;

  /// Whether [a] and [b] draw the same decisions, in the same order.
  static bool _sameAsks(List<SwarmDecisionNeed> a, List<SwarmDecisionNeed> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      final x = a[i].decision, y = b[i].decision;
      if (a[i].key != b[i].key ||
          x.askerName != y.askerName ||
          x.question != y.question ||
          x.unblocks != y.unblocks ||
          x.recommended != y.recommended ||
          x.createdAt != y.createdAt ||
          !listEquals(x.options, y.options)) {
        return false;
      }
    }
    return true;
  }

  @override
  bool operator ==(Object other) =>
      other is _ChatView &&
      other.known == known &&
      other.title == title &&
      other.project == project &&
      other.canPost == canPost &&
      other.archived == archived &&
      listEquals(other.names, names) &&
      mapEquals(other.roles, roles) &&
      listEquals(other.mentionable, mentionable) &&
      identical(other.decisions, decisions) &&
      other.buddyProject == buddyProject &&
      other.hint == hint;

  @override
  int get hashCode => Object.hash(
    known,
    title,
    project,
    canPost,
    archived,
    Object.hashAll(names),
    Object.hashAll(mentionable),
    decisions,
    buddyProject,
    hint,
  );
}

/// One row of the chat.
sealed class _Entry {}

/// Where a day starts.
final class _DayEntry extends _Entry {
  _DayEntry(this.day);
  final DateTime day;
}

final class _MessageEntry extends _Entry {
  _MessageEntry(this.message, {required this.grouped});
  final SuperTabMessage message;

  /// Drawn under the one before, with no avatar, name or time.
  final bool grouped;
}

/// A decision asked of the person, in its place among the messages.
final class _AskEntry extends _Entry {
  _AskEntry(this.need, {this.grouped = false});
  final SwarmDecisionNeed need;

  /// Drawn under its asker's message just before it, as part of it.
  final bool grouped;
}

/// [messages] (oldest first) with the [asks] put where they were asked and a
/// divider where each day starts. An ask from before the messages read so far
/// — while there are [hasOlder] ones — goes at the foot instead, so a question
/// still open is never out of sight behind "Earlier messages".
List<_Entry> _timeline(
  List<SuperTabMessage> messages,
  List<SwarmDecisionNeed> asks, {
  required bool hasOlder,
}) {
  final grouped = swarmGroupedMessages(messages);
  final oldest = messages.map((m) => m.createdAt).nonNulls.firstOrNull;
  bool before(DateTime? asked, DateTime? at) =>
      asked != null && at != null && asked.isBefore(at);
  final waiting = <SwarmDecisionNeed>[], late = <SwarmDecisionNeed>[];
  for (final ask in asks) {
    (hasOlder && before(ask.decision.createdAt, oldest) ? late : waiting).add(
      ask,
    );
  }
  waiting.sort((a, b) {
    final x = a.decision.createdAt, y = b.decision.createdAt;
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return x.compareTo(y);
  });

  final rows = <(_Entry, DateTime?)>[];
  // An ask right after its asker's own message — "One question before the
  // release:" — is drawn as part of it.
  void ask(SwarmDecisionNeed need) {
    final asked = need.decision.createdAt;
    final last = rows.lastOrNull?.$1;
    final at = last is _MessageEntry ? last.message.createdAt : null;
    final grouped =
        last is _MessageEntry &&
        last.message.fromAgent &&
        last.message.authorName == need.decision.askerName &&
        asked != null &&
        at != null &&
        !asked.isBefore(at) &&
        asked.difference(at) <= const Duration(minutes: 5);
    rows.add((_AskEntry(need, grouped: grouped), asked));
  }

  var next = 0;
  for (final m in messages) {
    while (next < waiting.length &&
        before(waiting[next].decision.createdAt, m.createdAt)) {
      ask(waiting[next]);
      next++;
    }
    // Grouped only right under a message: not under a question.
    final under = rows.isNotEmpty && rows.last.$1 is _MessageEntry;
    rows.add((
      _MessageEntry(m, grouped: under && grouped.contains(m.id)),
      m.createdAt,
    ));
  }
  waiting.skip(next).forEach(ask);
  for (final need in late) {
    rows.add((_AskEntry(need), need.decision.createdAt));
  }

  final timeline = <_Entry>[];
  DateTime? day;
  for (final (row, at) in rows) {
    if (at != null) {
      final local = DateUtils.dateOnly(at.toLocal());
      if (local != day) {
        day = local;
        timeline.add(_DayEntry(local));
      }
    }
    timeline.add(row);
  }
  return timeline;
}

const _weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// A day divider's words for [day] (local): Today, Yesterday, the weekday
/// within the week, else the date — with its year when it is not this one.
String swarmDayLabel(DateTime day, DateTime now) {
  final date = DateUtils.dateOnly(day), today = DateUtils.dateOnly(now);
  // In hours, rounded: a day across a clock change is 23 or 25 of them.
  final days = (today.difference(date).inHours / 24).round();
  if (days == 0) return 'Today';
  if (days == 1) return 'Yesterday';
  if (days > 1 && days < 7) return _weekdays[date.weekday - 1];
  final short = '${date.day} ${_months[date.month - 1]}';
  return date.year == today.year ? short : '$short ${date.year}';
}

/// The ids of [messages] (oldest first) drawn as follow-ups under the one
/// before: the same author within five minutes on the same day, short, with
/// no question, line break or reply, and at most three to a run — the
/// desktop's `SuperTabMessageRow.groupsWith`.
Set<String> swarmGroupedMessages(List<SuperTabMessage> messages) {
  bool joins(SuperTabMessage current, SuperTabMessage previous) {
    bool plain(SuperTabMessage m) =>
        m.replyTo == null &&
        m.text.length <= 280 &&
        !m.text.contains('\n') &&
        !m.text.contains('?') &&
        !m.text.contains('？');
    if (!plain(current) ||
        !plain(previous) ||
        current.authorId.isEmpty ||
        current.authorId != previous.authorId ||
        current.authorName != previous.authorName ||
        current.author['kind'] != previous.author['kind'] ||
        current.author['membershipGeneration'] !=
            previous.author['membershipGeneration']) {
      return false;
    }
    final now = current.createdAt, before = previous.createdAt;
    if (now == null || before == null) return false;
    final elapsed = now.difference(before);
    return !elapsed.isNegative &&
        elapsed <= const Duration(minutes: 5) &&
        DateUtils.isSameDay(now.toLocal(), before.toLocal());
  }

  final joined = <String>{};
  var first = 0;
  for (var i = 1; i < messages.length; i++) {
    if (i - first < 3 &&
        joins(messages[i], messages[i - 1]) &&
        joins(messages[i], messages[first])) {
      joined.add(messages[i].id);
    } else {
      first = i;
    }
  }
  return joined;
}

/// An agent's role as its compact badge says it (the Naming System): PM for
/// a project's Product Manager, Rev for a reviewer, Dev for an engineer;
/// none for a person, a Buddy (no engineer, though it runs as one; Desktop
/// shows it none either), or an agent no longer in the Swarm.
String? swarmRole(SuperTabSnapshot snapshot, SuperTabMessage message) {
  if (!message.fromAgent) return null;
  return swarmAgentRole(snapshot, message.authorId);
}

String? swarmAgentRole(SuperTabSnapshot snapshot, String agentId) {
  if (snapshot.isLead(agentId)) return 'PM';
  final agent = snapshot.agent(agentId);
  if (agent == null || agent.isBuddy) return null;
  return agent.isReviewer ? 'Rev' : 'Dev';
}

/// The agent asking [need], found by the name it asked under: a decision
/// names its asker, not their id.
SuperTabAgent? swarmAsker(SuperTabSnapshot snapshot, SwarmDecisionNeed need) =>
    snapshot.agents
        .where((a) => snapshot.agentName(a.id) == need.decision.askerName)
        .firstOrNull;

/// Around the chat's column of messages, and of the skeleton standing in for
/// them.
const _listPadding = EdgeInsets.fromLTRB(
  AppSpace.m,
  AppSpace.xs,
  AppSpace.m,
  AppSpace.m,
);

/// The chat's first page on its way: bubbles in the shape of messages, at
/// the foot where they will show. Each has a fixed number of lines, so none
/// changes height as it breathes.
class _ChatSkeleton extends StatelessWidget {
  const _ChatSkeleton();

  /// Each bubble's lines and its last line's width, newest last.
  static const _bubbles = [
    (2, 0.6),
    (1, 0.4),
    (3, 0.75),
    (1, 0.55),
    (2, 0.35),
    (1, 0.65),
    (2, 0.5),
  ];

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Loading messages',
    child: SingleChildScrollView(
      key: const ValueKey('swarm-chat-skeleton'),
      // From the foot, as the messages are; those that do not fit are cut
      // off at the top.
      reverse: true,
      physics: const NeverScrollableScrollPhysics(),
      padding: _listPadding,
      child: Column(
        children: [
          for (final (lines, width) in _bubbles)
            _SkeletonBubble(lines: lines, width: width),
        ],
      ),
    ),
  );
}

/// A message in outline: avatar, name, then [lines] lines of text, the last
/// [width] of the row wide — in the metrics of a real one.
class _SkeletonBubble extends StatelessWidget {
  const _SkeletonBubble({required this.lines, required this.width});

  final int lines;
  final double width;

  @override
  Widget build(BuildContext context) {
    final text = swarmChatText(16, height: 1.42);
    return Padding(
      padding: SwarmMessageFrame.padding(),
      child: SwarmMessageFrame(
        key: const ValueKey('swarm-skeleton-bubble'),
        grouped: false,
        avatar: const Skeleton(
          width: SwarmChatAvatar.size,
          height: SwarmChatAvatar.size,
          shape: BoxShape.circle,
        ),
        header: SkeletonText(
          style: swarmChatText(13.5, weight: FontWeight.w600),
          width: 88,
        ),
        body: [
          Padding(
            padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
            child: Column(
              children: [
                for (var line = 1; line <= lines; line++)
                  SkeletonText(
                    style: text,
                    widthFactor: line == lines ? width : 0.92,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Where a day starts: Today, Yesterday, the weekday or the date.
class _Day extends StatelessWidget {
  const _Day({required this.day, required this.today});

  final DateTime day, today;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, AppSpace.l, 0, AppSpace.s),
      child: Text(
        swarmDayLabel(day, today),
        textAlign: TextAlign.center,
        style: Tty.of(context).style(color: AppPalette.textFaint, size: 12.5),
      ),
    );
  }
}

/// How many messages arrived below while the person read back; a tap goes
/// down to them.
class _NewPill extends StatelessWidget {
  const _NewPill({required this.count, required this.onTap});

  static const double _height = 36;

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: count == 1 ? '1 new message' : '$count new messages',
    excludeSemantics: true,
    child: GestureDetector(
      key: const ValueKey('swarm-new-pill'),
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      // 44 to tap, 36 to see.
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
        child: Container(
          height: _height,
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
          decoration: BoxDecoration(
            color: AppPalette.accent,
            // An action button's capsule.
            borderRadius: BorderRadius.circular(_height / 2),
            boxShadow: AppSurface.shadow,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(LucideIcons.arrowDown, size: 16, color: AppInk.onFill),
              const SizedBox(width: 6),
              Text(
                '$count new',
                style: swarmChatText(
                  14,
                  color: AppInk.onFill,
                  weight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// The person's post on its way: "Sending…", then — its answer lost — "Not
/// confirmed" with Send again, until it is read back.
class _Pending extends StatelessWidget {
  const _Pending({
    super.key,
    required this.name,
    required this.text,
    required this.files,
    required this.mentions,
    required this.sending,
    required this.quote,
    required this.onSendAgain,
    required this.look,
  });

  final String name, text;

  /// The files going with it, already uploaded: shown as chips that open
  /// nothing until the post is read back with their links.
  final List<SwarmOutgoingFile> files;

  /// The person's own face.
  final SwarmLook look;
  final SwarmMentions mentions;
  final bool sending;
  final Widget? quote;
  final VoidCallback onSendAgain;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Padding(
      key: const ValueKey('swarm-pending'),
      padding: SwarmMessageFrame.padding(),
      child: SwarmMessageFrame(
        grouped: false,
        avatar: SwarmChatAvatar(
          name: name,
          id: '',
          agent: false,
          picture: look.picture,
          status: look.status,
        ),
        header: SwarmMessageHeader(
          name: name,
          agent: false,
          trailing: Text(
            sending ? 'Sending…' : 'Not confirmed',
            style: tty.style(
              color: sending ? AppPalette.textFaint : tty.yellow,
              size: 12.5,
            ),
          ),
        ),
        body: [
          ?quote,
          if (text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
              child: Text.rich(
                mentions.span(
                  text,
                  swarmChatText(
                    16,
                    height: 1.42,
                    color: sending
                        ? AppPalette.textSecondary
                        : AppPalette.textPrimary,
                  ),
                ),
              ),
            ),
          for (final file in files)
            SwarmFileChip(
              file: SuperTabAttachment.fromJson({
                'id': '',
                'name': file.name,
                'mime': swarmMimeForName(file.name),
                'size': file.bytes.length,
                'url': '',
              }),
              link: null,
            ),
          if (!sending)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.s),
              child: SwarmSmallButton(
                key: const ValueKey('swarm-resend-post'),
                icon: LucideIcons.rotateCw,
                label: 'Send again',
                onTap: onSendAgain,
              ),
            ),
        ],
      ),
    );
  }
}

/// A decision asked of the person, among the messages: from its asker, a card
/// with the question and its options side by side.
class _Ask extends StatelessWidget {
  const _Ask({
    required this.session,
    required this.need,
    required this.grouped,
    required this.askerId,
    required this.role,
    required this.picture,
  });

  final SwarmSession session;

  /// The picture its asker chose.
  final SuperTabAvatarPicture? picture;
  final SwarmDecisionNeed need;
  final bool grouped;

  /// Its asker in the Swarm and their role; null for one no longer in it.
  final String? askerId, role;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final decision = need.decision;
    final at = decision.createdAt?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return Padding(
      key: ValueKey('swarm-ask-${decision.id}'),
      padding: SwarmMessageFrame.padding(grouped: grouped),
      child: SwarmMessageFrame(
        grouped: grouped,
        avatar: SwarmChatAvatar(
          name: decision.askerName,
          id: askerId ?? decision.askerName,
          agent: true,
          pm: role == 'PM',
          picture: picture,
        ),
        header: SwarmMessageHeader(
          name: decision.askerName,
          agent: true,
          role: role,
          trailing: at == null
              ? null
              : Text(
                  '${two(at.hour)}:${two(at.minute)}',
                  style: tty.style(color: AppPalette.textFaint, size: 12.5),
                ),
        ),
        body: [
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(top: AppSpace.s),
            padding: const EdgeInsets.fromLTRB(
              AppSpace.l,
              AppSpace.m,
              AppSpace.l,
              AppSpace.l,
            ),
            decoration: BoxDecoration(
              color: swarmChatCard(tty),
              border: Border.all(color: swarmChatHair(tty)),
              borderRadius: BorderRadius.circular(AppCard.radius),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(decision.question, style: swarmChatText(16, height: 1.4)),
                if (decision.unblocks.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    'Unblocks: ${decision.unblocks}',
                    style: swarmChatText(13.5, color: AppPalette.textSecondary),
                  ),
                ],
                const SizedBox(height: 14),
                // Its answer held, sending or dropped: told by the session
                // and the Swarm's asks, not by the chat around it.
                ListenableBuilder(
                  listenable: Listenable.merge([
                    session,
                    ?session.inbox.asks(need.swarmId),
                  ]),
                  builder: (context, _) => SwarmDecisionAnswer(
                    session: session,
                    need: need,
                    fillRecommended: true,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The chat's agents whose name starts with what follows the @ being typed,
/// over the composer: each with its role and what it is doing.
class _MentionPicker extends StatelessWidget {
  const _MentionPicker({
    required this.agents,
    required this.snapshot,
    required this.query,
    required this.onPick,
  });

  final List<SuperTabAgent> agents;
  final SuperTabSnapshot snapshot;
  final String query;
  final ValueChanged<SuperTabAgent> onPick;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final glances = {
      for (final glance in swarmTeamGlance(snapshot).agents)
        glance.agent.id: glance,
    };
    final prefix = query.toLowerCase();
    final shown = [
      for (final agent in agents)
        if (snapshot.agentName(agent.id).toLowerCase().startsWith(prefix))
          agent,
    ];
    return Container(
      key: const ValueKey('swarm-mention-picker'),
      margin: const EdgeInsets.only(bottom: AppSpace.s),
      constraints: const BoxConstraints(maxHeight: 220),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: swarmChatCard(tty),
        border: Border.all(color: swarmChatHair(tty)),
        borderRadius: BorderRadius.circular(AppMenu.panelRadius),
        boxShadow: AppSurface.shadow,
      ),
      child: shown.isEmpty
          ? Padding(
              padding: const EdgeInsets.all(AppSpace.l),
              child: Text(
                'No agent by that name.',
                style: swarmChatText(14, color: AppPalette.textSecondary),
              ),
            )
          : ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: [
                for (final agent in shown)
                  TtyTap(
                    key: ValueKey('swarm-pick-${agent.id}'),
                    semanticsLabel: snapshot.agentName(agent.id),
                    minHeight: 52,
                    onTap: () => onPick(agent),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.l,
                      ),
                      child: Row(
                        children: [
                          SwarmChatAvatar(
                            name: snapshot.agentName(agent.id),
                            id: agent.id,
                            agent: true,
                            pm: snapshot.isLead(agent.id),
                            picture: agent.avatar,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    snapshot.agentName(agent.id),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: swarmChatText(
                                      16,
                                      weight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                                if (swarmAgentRole(snapshot, agent.id)
                                    case final role?) ...[
                                  const SizedBox(width: 6),
                                  SwarmRoleBadge(role),
                                ],
                              ],
                            ),
                          ),
                          if (glances[agent.id] case final glance?) ...[
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: _stateColor(tty, glance.state),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              glance.label,
                              style: swarmChatText(
                                13,
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
              ],
            ),
    );
  }
}

/// The dot beside what an agent is doing: green working, yellow waiting or
/// stuck, red down or limited, faint idle.
Color _stateColor(Tty tty, SwarmAgentState state) => switch (state) {
  SwarmAgentState.working => tty.green,
  SwarmAgentState.waiting || SwarmAgentState.stuck => tty.yellow,
  SwarmAgentState.down || SwarmAgentState.limited => tty.red,
  _ => AppPalette.textFaint,
};

/// Under the PM's private line in the person's Buddy chat: Answer in #project,
/// and that everyone there reads the answer.
class _AnswerIn extends StatelessWidget {
  const _AnswerIn({super.key, required this.project, required this.onTap});

  /// "#Mobile".
  final String project;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Wrap(
    crossAxisAlignment: WrapCrossAlignment.center,
    spacing: AppSpace.s,
    children: [
      SwarmButton(
        label: 'Answer in $project',
        style: SwarmButtonStyle.link,
        onPressed: onTap,
      ),
      Text(
        'Everyone there reads it',
        style: AppType.caption(color: AppPalette.textSecondary),
      ),
    ],
  );
}

/// The composer's field: one rounded line that grows with what is typed, up
/// to five, in the app's own face.
class _MessageField extends StatelessWidget {
  const _MessageField({
    required this.controller,
    required this.focus,
    required this.hint,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return GestureDetector(
      // A tap anywhere in the pill — not only on the text — takes the keyboard.
      behavior: HitTestBehavior.opaque,
      onTap: focus.requestFocus,
      child: Container(
        key: const ValueKey('swarm-field'),
        constraints: const BoxConstraints(minHeight: 44),
        alignment: Alignment.centerLeft,
        // One line rests at the 44 of the buttons beside it.
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpace.l,
          vertical: AppSpace.s,
        ),
        decoration: BoxDecoration(
          color: ttyRaised(tty),
          border: Border.all(color: swarmChatHair(tty)),
          // A text field's rounded rectangle.
          borderRadius: BorderRadius.circular(AppControl.radius),
        ),
        child: TextSelectionTheme(
          data: TextSelectionThemeData(
            cursorColor: AppPalette.accentOnSurface,
            selectionColor: AppPalette.accentOnSurface.withValues(alpha: 0.3),
            selectionHandleColor: AppPalette.accentOnSurface,
          ),
          child: TextField(
            controller: controller,
            focusNode: focus,
            minLines: 1,
            maxLines: 5,
            keyboardType: TextInputType.multiline,
            textInputAction: TextInputAction.newline,
            textCapitalization: TextCapitalization.sentences,
            // The keyboard's own composing, left on: Vietnamese Telex on iOS
            // rides on autocorrection. See `ComposingKeyboard`.
            autocorrect: ComposingKeyboard.autocorrect,
            enableSuggestions: ComposingKeyboard.enableSuggestions,
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            cursorColor: AppPalette.accentOnSurface,
            cursorWidth: 2,
            style: swarmChatText(16, height: 22 / 16),
            decoration: InputDecoration(
              isCollapsed: true,
              // No minimum of its own: the pill's 44 is the field's height.
              constraints: const BoxConstraints(),
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              contentPadding: EdgeInsets.zero,
              hintText: hint,
              hintStyle: swarmChatText(
                16,
                height: 22 / 16,
                color: AppPalette.textFaint,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A round 44pt button: @, Send, the reply bar's ✕. [fill] draws it solid.
class _Round extends StatelessWidget {
  const _Round({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
    this.fill,
  });

  final String label;
  final VoidCallback? onTap;
  final Widget child;
  final Color? fill;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: onTap != null,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
        child: child,
      ),
    ),
  );
}

/// A link in the accent: Earlier messages.
class _Link extends StatelessWidget {
  const _Link({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TtyTap(
    semanticsLabel: label,
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
      child: Text(
        label,
        style: swarmChatText(15, color: AppPalette.accentOnSurface),
      ),
    ),
  );
}
