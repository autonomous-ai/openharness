import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/app_settings.dart';
import 'package:harness_mobile/phone/composing_keyboard.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_recorder.dart' show VoiceTake;
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'identity.dart';
import 'model.dart';
import 'prompt_alerts.dart';
import 'swarm_code_block.dart';
import 'swarm_outbox.dart';
import 'swarm_post_line.dart';
import 'swarm_attach.dart';
import 'swarm_buddy.dart';
import 'swarm_buddy_chat.dart';
import 'swarm_session_widgets.dart';
import 'swarm_buddy_tab.dart'
    show SwarmBuddyDot, SwarmBuddyMark, swarmBuddyMark;
import 'swarm_chat_find.dart';
import 'swarm_chat_menu.dart';
import 'swarm_file_links.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'linked_tasks.dart' show superTabIsStep, superTabStepName;
import 'task_steps.dart';
import 'swarm_face.dart';
import 'swarm_file_picker.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_inbox.dart';
import 'swarm_lead_start.dart';
import 'swarm_lead_start_card.dart';
import 'swarm_reader.dart';
import 'swarm_live_card.dart';
import 'swarm_link_previews.dart';
import 'swarm_message_edit.dart';
import 'swarm_message_link.dart';
import 'swarm_message_receipt.dart';
import 'swarm_message_row.dart';
import 'swarm_need_rows.dart';
import 'swarm_paste.dart';
import 'swarm_profile_sheet.dart';
import 'swarm_project_page.dart';
import 'swarm_reactions.dart';
import 'swarm_read_marks.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_thread.dart';
import 'swarm_thread_line.dart';
import 'swarm_thread_page.dart';
import 'swarm_unread_line.dart';
import 'swarm_voice.dart';
import 'swarm_voice_bubble.dart';
import 'swarm_voice_send.dart' show SwarmVoicePosted;
import 'voice_length.dart';
import 'team_glance.dart';

final _conversationReferencePattern = RegExp(r'(?<![\w/])#([1-9][0-9]*)(?!\w)');

/// What a message can link to from the current read of its Swarm. A chat may
/// still hold an older reader while the inbox has replaced it.
@visibleForTesting
Map<int, String> swarmNumberedReferences(SwarmReader? reader, String text) {
  if (reader == null || reader.accessRevoked) return const {};
  final numbers = _conversationReferencePattern
      .allMatches(text)
      .map((match) => int.tryParse(match[1]!))
      .whereType<int>()
      .toSet();
  return {
    for (final conversation
        in reader.snapshot?.conversations ?? const <SuperTabConversation>[])
      if (conversation.number != null && numbers.contains(conversation.number))
        conversation.number!: conversation.id,
  };
}

/// The same current-reader access check used when a numbered link is tapped.
@visibleForTesting
bool swarmCanOpenNumberedConversation(SwarmReader? reader, String id) =>
    reader != null &&
    !reader.accessRevoked &&
    reader.snapshot?.conversation(id) != null;

/// Opens [conversationId] of Swarm [swarmId] over the current page: a
/// project's own chat as its project ([SwarmOpenedChat]).
void openSwarmConversation(
  BuildContext context,
  String swarmId,
  String conversationId,
) => unawaited(
  Navigator.of(context)
      .push(swarmChatRoute(swarmId: swarmId, conversationId: conversationId)),
);

/// Opens this app's page in the phone's Settings, where a refused camera is turned back on.
/// Replaced in tests, where there is no Settings to open.
@visibleForTesting
Future<bool> Function() openSwarmSettings = openAppSettings;

/// A composer's + — the chat's, or a thread's reply box: the sheet, then the
/// picker it names, its files into [files], and what to say under the box to
/// [note]. A refusal of the camera or photos offers the phone's Settings.
/// Nothing is added, or said, once [stillWanted] fails.
Future<void> attachSwarmFiles(
  BuildContext context,
  SwarmOutgoingFiles files, {
  required bool Function() stillWanted,
  required ValueChanged<String?> note,
}) async {
  final source = await showSwarmAttachSheet(context);
  if (source == null || !stillWanted()) return;
  final outcome = await addSwarmPicked(files, source, stillWanted: stillWanted);
  if (!stillWanted() || !context.mounted) return;
  switch (outcome) {
    case SwarmPicked(note: final said):
      note(said);
    case SwarmPickFailed(:final message):
      note(message);
    case SwarmPickDenied(:final source):
      note(null);
      if (await showSwarmAccessOff(context, source)) {
        unawaited(openSwarmSettings());
      }
  }
}

/// One conversation: its messages, newest at the foot, older ones on demand —
/// each with who wrote it, their role and when, follow-ups grouped, a reply's
/// quote leading to its original; in the person's own Buddy chat, the
/// decisions asked of them in its project, as Desktop shows them there (no
/// other chat shows decisions: they are answered in Activity); and, for a
/// writer, a composer that posts text, as a reply or with
/// @mentions of the conversation's agents picked as they are typed, and with
/// files from the photo library, the camera or Files ([swarmSendsFiles]). A
/// post shows at once and says when it is not confirmed.
class SwarmConversationPage extends StatefulWidget {
  const SwarmConversationPage({
    super.key,
    required this.swarmId,
    required this.conversationId,
    this.header = true,
    this.findRequests,
    this.buddy,
    this.messageId,
    this.threadId,
    this.threadFocus,
    this.mention,
    this.homeC = false,
    this.tabRoot = false,
    this.swarmSwitch,
  });

  final String swarmId, conversationId;
  final String? messageId;

  /// A thread to open over the chat as it opens, when [messageId] is its
  /// root: as Threads opens one on the desktop (`_openThreadFromList`), the
  /// chat behind it at the root.
  final String? threadId;

  /// Where [threadId]'s thread lands as it opens; its top when none.
  final SwarmThreadFocus? threadFocus;

  /// An agent to @mention in the draft as the chat opens: the PM, as its
  /// private line is answered in the project chat.
  final String? mention;

  /// Its own header: back, its name and its project, and — the person's own
  /// Buddy chat — Remove Buddy at its end. None in a project's tab
  /// (`swarm_project_page.dart`), under the project's own header.
  final bool header;

  /// Told when the page around the chat asks to find in it: the project's
  /// own menu, where the chat has no header of its own (task #2826).
  final Listenable? findRequests;

  /// What the person does to their Buddy, where the page around the chat
  /// holds it, for its own header's menu; null makes the chat its own while
  /// it is their Buddy chat.
  final SwarmBuddyActions? buddy;

  /// Swarm Home C's project chat (Tony, 2026-10-30): it gates only the
  /// add-reaction chip after a message's reactions.
  final bool homeC;

  /// At the root of a tab, as the Buddy tab holds the person's Buddy chat: no
  /// back in its header, and its Buddy's dot before its name.
  final bool tabRoot;

  /// The Swarm it is in and how to pick another, for its Buddy menu; null with
  /// no other Swarm to pick.
  final SwarmBuddySwitch? swarmSwitch;

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

  /// Why New session is greyed, once it is tapped (a phone has no hover).
  final _sessionNote = ValueNotifier<String?>(null);

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
  bool _noticeHandled = false;
  final _targetKey = GlobalKey();
  Timer? _litTimer;
  bool _finding = false;
  String? _note;

  /// Earlier messages are read on their own as the person nears the top;
  /// "Earlier messages" is offered only once that read failed.
  bool _loadingOlder = false, _olderFailed = false;

  /// Find in the chat (task #2826), while its bar is open under the header;
  /// and its current match as last brought into view, which stays
  /// [_target] and [_lit] for as long as it is current.
  SwarmChatFind? _find;
  String? _found;
  bool _findRefreshing = false;

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

  /// Whether this chat's Swarm has not been read yet, so the server's read
  /// mark for it is not known (a notice tapped at launch, a Swarm read that
  /// failed): the New messages line waits for the first read that works, and
  /// nothing is read until then, as until the line is placed.
  bool _swarmUnread = false;

  /// The chat's first read is done, so its line can be placed.
  bool _firstRead = false;

  /// The person reads more than a screen back, where Jump to latest is
  /// offered.
  final _farBack = ValueNotifier<bool>(false);

  /// Each entry's row as last built, with what it was built from ([_row]).
  final _rows = <String, ({Object inputs, Widget row})>{};

  /// The New messages line: the message it sits above once placed, and
  /// whether it was placed this visit.
  String? _lineAt;
  bool _lineDecided = false;

  /// The read marks the line waits on: the phone's, not read back yet when
  /// the chat's first read came ([_placeLine]).
  SwarmReadMarks? _marksAwaited;
  final _lineKey = GlobalKey(debugLabel: 'New messages line');

  /// The line has been in view this visit: reading on needs no way back.
  bool _lineSeen = false;

  /// The line is above the view and not yet seen, where Jump to first unread
  /// is offered ([_measureLine]).
  final _offersUnread = ValueNotifier<bool>(false);

  /// The jump still landing: its passing scroll neither counts the line as
  /// seen nor changes what is offered. Each jump takes a new number.
  int? _landing;
  int _landings = 0;
  bool _measuring = false;

  /// No message has this id: held at it, a chat reads nothing until its New
  /// messages line is placed ([SwarmConversation.heldAt]).
  static const _undecided = '';

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
    widget.findRequests?.addListener(_openFind);
  }

  @override
  void didUpdateWidget(SwarmConversationPage old) {
    super.didUpdateWidget(old);
    if (old.findRequests != widget.findRequests) {
      old.findRequests?.removeListener(_openFind);
      widget.findRequests?.addListener(_openFind);
    }
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
    // Uncovered, what came meanwhile is read, which tells the whole inbox:
    // not while this frame builds.
    if (_seen) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _conversation?.shown = _seen;
      });
    } else {
      _conversation?.shown = false;
    }
    if (_voice == null) {
      if (SwarmScope.voiceOf(context) case final create?) {
        _voice = SwarmVoice(recorder: create, post: _voiceSend);
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
    _swarmUnread = reader.snapshot == null;
    // Set before what the chat kept is shown, so it is read only as far as
    // it is seen: with a New messages line to place, nothing until it is
    // placed, a notice's message included, or the line would sit under it;
    // opened at a message, through it until the person goes down to the foot.
    final c = _conversation = SwarmConversation(
      reader,
      widget.conversationId,
      shown: _seen,
      heldAt: _lineDecided ? widget.messageId ?? _held.value : _undecided,
    );
    c.composer.addListener(_drafted);
    // The draft it kept, in the box.
    _drafted();
    c.addListener(_chatMoved);
    c.addListener(_guardVoice);
    if (widget.mention case final agentId?) c.mention(agentId);
    reader.addListener(_see);
    reader.addListener(_guardVoice);
    session.inbox.addListener(_see);
    session.home.addListener(_see);
    _see();
    _watch();
    unawaited(
      c.load().then((_) {
        // A chat left behind may finish reading after its replacement began.
        if (!mounted || _conversation != c) return;
        _firstRead = true;
        _chatMoved();
      }),
    );
    if (rebuild && mounted) setState(() {});
  }

  /// Places the chat's New messages line once, from what the chat's
  /// first read brought and how far the person had read it
  /// ([SwarmReadMarks.readThrough]; nothing here is read until then, so that is
  /// how far as it opened) ([swarmFirstUnread]), above a row the chat draws:
  /// never a prompt's warning already answered, which a task's chat often
  /// has (Desktop's `_ownShown`).
  /// The phone's marks may come back after the first read: the chat stays
  /// held, and the line is placed once they are back ([_marksMoved]). It
  /// stays there however the chat and its marks move on. Without one,
  /// everything shown is read. A line above
  /// the screen opens the chat at it ([_openAtLine]), unless a notice opened
  /// it at a message. A read that failed says nothing of what is unread: the
  /// chat stays held, and the first read that works places it ([_chatMoved]).
  void _placeLine(SwarmConversation c) {
    if (!mounted || _conversation != c || _lineDecided || _swarmUnread) {
      return;
    }
    if (c.state != SwarmChatState.loaded || c.error != null) return;
    final marks = c.reader.readMarks;
    if (marks != null && !marks.loaded) {
      if (_marksAwaited != marks) {
        _stopAwaitingMarks();
        _marksAwaited = marks..addListener(_marksMoved);
      }
      return;
    }
    _stopAwaitingMarks();
    _lineDecided = true;
    final drawn = {for (final m in _drawnOf(c).rows) m.id};
    final at = swarmFirstUnread(
      c.messages,
      c.reader.readMarks?.readThrough(c.id),
      accountId: c.reader.accountId,
      hasOlder: c.hasOlder,
      drawn: (m) => drawn.contains(m.id),
    );
    if (at == null) {
      _releaseHold(c);
      return;
    }
    setState(() => _lineAt = at);
    if (widget.messageId == null) {
      _openAtLine(c, at, 0);
    } else {
      _releaseHold(c);
      _measureLineSoon();
    }
  }

  /// The line is decided: the chat is read as far as a notice opened it at, or
  /// the person had read back to, else to its foot.
  void _releaseHold(SwarmConversation c) {
    if (c.heldAt == _undecided) c.heldAt = widget.messageId ?? _held.value;
  }

  /// A take goes with the right to post here, as in a thread: the chat lost,
  /// archived, or the person no longer a writer. Its words land nowhere
  /// ([SwarmVoice.hide]). Nothing while the chat is still being read.
  void _guardVoice() {
    final c = _conversation;
    if (c == null || c.reader.snapshot == null && !c.reader.accessRevoked) {
      return;
    }
    if (c.state == SwarmChatState.lost || !c.canPost) _voice?.hide();
  }

  /// A read came in: the line, if a failed read left it to place; the notice's
  /// message, once a read has brought what to look for it in; and what is
  /// offered of the line, since the list changed.
  void _chatMoved() {
    final c = _conversation;
    if (c == null || !_firstRead) return;
    if (!_lineDecided) _placeLine(c);
    if (!_noticeHandled &&
        c.state == SwarmChatState.loaded &&
        c.error == null) {
      if (widget.messageId case final messageId?) {
        _noticeHandled = true;
        unawaited(_jumpTo(c, messageId));
      }
    }
    _measureLineSoon();
  }

  /// The marks the line waits on moved: back, it is placed. Only the chat's
  /// first read waits on them, so that read is in.
  void _marksMoved() {
    if (_conversation case final c?) _placeLine(c);
  }

  void _stopAwaitingMarks() {
    _marksAwaited?.removeListener(_marksMoved);
    _marksAwaited = null;
  }

  /// Once the line is drawn: on screen, all that is shown is read; above
  /// it, the chat goes to the line, and what came before the line is read
  /// while the rest waits until the person goes down to it. The list builds
  /// only the rows near what is shown, so it jumps near the line by its place
  /// until its row is built, as [_reveal] does. Jump to first unread comes
  /// here at [attempt] 1: what is read does not move.
  void _openAtLine(
    SwarmConversation c,
    String at,
    int attempt, {
    int? landing,
  }) {
    final jump = landing ?? _land();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _conversation != c || _lineAt != at) return _landed(jump);
      final row = _lineKey.currentContext;
      if (attempt == 0) {
        if (row != null && _onScreen(row)) {
          if (c.heldAt == _undecided) c.heldAt = null;
          return _landed(jump);
        }
        final place = c.messages.indexWhere((m) => m.id == at);
        if (place > 0 && c.heldAt == _undecided) {
          c.heldAt = c.messages[place - 1].id;
        }
      }
      if (row != null) {
        unawaited(
          Scrollable.ensureVisible(
            row,
            alignment: 1,
          ).whenComplete(() => _landed(jump)),
        );
        return;
      }
      final index = _shown.indexWhere((entry) => entry is _LineEntry);
      if (!_scroll.hasClients || index < 0 || attempt > 20) {
        return _landed(jump);
      }
      _scroll.position.jumpTo(_offsetNear(index));
      _openAtLine(c, at, attempt + 1, landing: jump);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// Whether [row]'s top is inside its list: the list runs from the foot, so
  /// a row drawn there is on screen unless it starts above the list's top.
  static bool _onScreen(BuildContext row) => (_topInList(row) ?? -1) >= 0;

  /// How far [row]'s top is below its list's top; null until both are laid
  /// out.
  static double? _topInList(BuildContext row) {
    final box = row.findRenderObject(), list = Scrollable.maybeOf(row);
    final view = list?.context.findRenderObject();
    if (box is! RenderBox || view is! RenderBox) return null;
    if (!box.hasSize || !view.hasSize) return null;
    return box.localToGlobal(Offset.zero).dy -
        view.localToGlobal(Offset.zero).dy;
  }

  /// Where the list scrolls to bring the entry at [index] of [_shown] near,
  /// by its place: the rows not built have no place of their own yet.
  double _offsetNear(int index) {
    final position = _scroll.position;
    return (position.maxScrollExtent * (index + 1) / _shown.length).clamp(
      0,
      position.maxScrollExtent,
    );
  }

  /// A jump starts: what is offered stays as it is until it has landed.
  int _land() => _landing = ++_landings;

  /// Jump [landing] is over: the line is measured where the list lays out
  /// next, unless a newer jump has started.
  void _landed(int landing) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _landing != landing) return;
      _landing = null;
      _measureLine();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// [_measureLine] once this frame is laid out: a scroll or a read may come
  /// in the middle of it.
  void _measureLineSoon() {
    if (_lineAt == null || _lineSeen || _measuring) return;
    _measuring = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _measuring = false;
      if (mounted) _measureLine();
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  /// Offers Jump to first unread while the line is above the view and has not
  /// been seen (Desktop's `_checkUnreadLine`). A line not laid out is told by
  /// its place in the list. A jump still landing passes lines it does not stop
  /// at: what is offered stays as it was until the line is measured where the
  /// jump landed.
  void _measureLine() {
    if (_landing != null) return;
    var offers = false;
    if (_lineAt != null && !_lineSeen && _scroll.hasClients) {
      final position = _scroll.position;
      final row = _lineKey.currentContext;
      final top = row == null ? null : _topInList(row);
      if (top != null) {
        // Less than a point past the top: where the jump to the line puts it.
        if (top >= -1 && top < position.viewportDimension) _lineSeen = true;
        offers = top < -1;
      } else {
        final index = _shown.indexWhere((entry) => entry is _LineEntry);
        offers = index >= 0 && _offsetNear(index) > position.pixels;
      }
    }
    _offersUnread.value = offers;
  }

  /// Takes the person to the New messages line.
  void _jumpToFirstUnread() {
    final c = _conversation, at = _lineAt;
    if (c == null || at == null) return;
    _openAtLine(c, at, 1);
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
    _syncSteps(c);
    if (_swarmUnread && c.reader.snapshot != null) {
      _swarmUnread = false;
      if (_firstRead) _placeLine(c);
    }
    final view = _view.value = _ChatView.of(session, c, _view.value);
    _seeBuddy(c, view.buddyProject);
  }

  /// What the person does to their Buddy from its chat, while this is their
  /// own Buddy chat in [project] ([SwarmBuddyActions]).
  SwarmBuddyActions? _buddy;

  void _seeBuddy(SwarmConversation c, String? project) {
    final kept = _buddy;
    if (kept?.reader == c.reader && kept?.projectId == project) return;
    if (kept != widget.buddy) kept?.dispose();
    _buddy = switch (widget.buddy) {
      _ when project == null => null,
      final held? when held.reader == c.reader && held.projectId == project =>
        held,
      _ => SwarmBuddyActions(c.reader, project),
    };
  }

  void _close() {
    final session = _session;
    // Signed out, another account, or Swarm turned off: the take goes with
    // the chat it was for.
    _voice?.hide();
    session?.inbox
      ?..removeListener(_attach)
      ..removeListener(_see);
    session?.home.removeListener(_see);
    if (_conversation case final c?) {
      c.composer.removeListener(_drafted);
      c.removeListener(_chatMoved);
      c.removeListener(_guardVoice);
      c.reader.removeListener(_see);
      c.reader.removeListener(_guardVoice);
      c.dispose();
    }
    for (final step in _steps.values) {
      step
        ..removeListener(_stepsMoved)
        ..dispose();
    }
    _steps.clear();
    if (_buddy != widget.buddy) _buddy?.dispose();
    _buddy = null;
    // Find goes with the chat it searched, a read-back under way too.
    _dropFind();
    _rows.clear();
    _madeFrom = null;
    _lineAt = null;
    _lineDecided = false;
    _lineSeen = false;
    _landing = null;
    _offersUnread.value = false;
    _swarmUnread = false;
    _firstRead = false;
    _farBack.value = false;
    _stopAwaitingMarks();
    if (_watching) session?.unwatch(widget.swarmId);
    _watching = false;
    _conversation = null;
    session?.leave();
    _session = null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.findRequests?.removeListener(_openFind);
    _close();
    _voice?.dispose();
    _view.dispose();
    _held.dispose();
    _farBack.dispose();
    _offersUnread.dispose();
    _litTimer?.cancel();
    _text.dispose();
    _focus.dispose();
    _attachNote.dispose();
    _sessionNote.dispose();
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

  /// The composer's + ([attachSwarmFiles]), its files into [c]'s.
  Future<void> _pickFiles(SwarmConversation c) async {
    if (_picking) return;
    _picking = true;
    try {
      await attachSwarmFiles(
        context,
        c.files,
        stillWanted: () => mounted && _conversation == c,
        note: (note) => _attachNote.value = note,
      );
    } finally {
      _picking = false;
    }
  }

  /// A picture pasted into the composer ([pasteSwarmImage]), into [c]'s
  /// files, as the + puts a photo there.
  Future<void> _pasteImage(SwarmConversation c, SwarmPastedImage image) =>
      pasteSwarmImage(
        c.files,
        image,
        stillWanted: () => mounted && _conversation == c,
        note: (note) => _attachNote.value = note,
      );

  /// How far up the chat the person reads back, past which a message that
  /// arrives waits below instead of pushing up what they read.
  static const _readingBack = 48.0;

  void _scrolled() {
    _nearTop();
    if (!_scroll.hasClients) return;
    _measureLineSoon();
    final back = _scroll.offset > _readingBack;
    _farBack.value = _scroll.offset > _scroll.position.viewportDimension;
    // At the foot all is seen; reading back, only what was seen at the foot
    // before, or the message a notice opened the chat at.
    if (_conversation case final c?) {
      if (!back) {
        c.heldAt = null;
      } else {
        c.heldAt ??= c.stream.lastOrNull?.id;
      }
    }
    if (back == (_held.value != null)) return;
    _held.value = back ? _conversation?.stream.lastOrNull?.id : null;
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
        _findReading ||
        !_scroll.hasClients) {
      return;
    }
    final position = _scroll.position;
    // The list runs from the foot: what is after the view is above it.
    if (position.extentAfter < position.viewportDimension) {
      unawaited(_loadOlder(c));
    }
  }

  /// Find reads older pages itself: the near-top read waits until it is
  /// done.
  bool get _findReading => _find?.reading != null;

  /// Opens find under the header, from the chat's ⋮.
  void _openFind() {
    final c = _conversation;
    if (c == null || _find != null || !mounted) return;
    final find = SwarmChatFind(
      rows: () => _findRows(c),
      hasOlder: () => c.hasOlder,
      readOlder: () => _findOlder(c),
    )..addListener(_findMoved);
    setState(() => _find = find);
  }

  /// ✕: the query, the fills and the light go, and a read-back stops.
  void _closeFind() {
    if (_find == null) return;
    _dropFind();
    if (mounted) setState(() {});
  }

  void _dropFind() {
    final find = _find;
    if (find == null) return;
    find
      ..removeListener(_findMoved)
      ..dispose();
    _find = null;
    if (_target == _found) _target = null;
    if (_lit == _found) _lit = null;
    _found = null;
  }

  /// What find searches: the messages the list draws, oldest first, as far
  /// as it draws them — those waiting below while the person reads back
  /// join once they show. Thread-only replies are the thread's own.
  List<SuperTabMessage> _findRows(SwarmConversation c) {
    final rows = _drawnOf(c).rows;
    final held = _held.value;
    final at = held == null ? -1 : rows.lastIndexWhere((m) => m.id == held);
    return at < 0 ? rows : rows.sublist(0, at + 1);
  }

  /// One older page for find, as scrolling back reads it: false when it
  /// failed, or brought nothing while more is said to be there.
  Future<bool> _findOlder(SwarmConversation c) async {
    final shown = c.messages.length;
    await c.loadOlder();
    if (!mounted || _conversation != c) return false;
    return c.messages.length > shown || (!c.hasOlder && c.error == null);
  }

  /// Find moved: a new current match is brought into view and lit, as a
  /// message link's original is, and stays lit while it is current.
  void _findMoved() {
    final find = _find, c = _conversation;
    if (find == null || c == null || !mounted) return;
    final current = find.current;
    if (current != _found) {
      _litTimer?.cancel();
      if (_target == _found) _target = null;
      if (_lit == _found) _lit = null;
      _found = current;
      if (current != null) {
        _target = current;
        _lit = current;
        _reveal(c, current, 0);
      }
    }
    setState(() {});
  }

  /// The rows the list draws changed: find counts them again once this
  /// frame is built.
  void _refreshFindSoon() {
    if (_find == null || _findRefreshing) return;
    _findRefreshing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _findRefreshing = false;
      if (mounted) _find?.refresh();
    });
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

  /// The voice row's Send: the take as a voice message, in the chat shown
  /// now, its words heard in the mic's language.
  Future<SwarmVoicePosted> _voiceSend(VoiceTake take) async {
    final c = _conversation;
    if (!mounted || c == null) return (sent: false, notice: null);
    _target = null;
    return c.sendVoice(take, voiceLanguageStore.value);
  }

  /// Sends the draft, back at the foot of the chat where the post shows.
  void _send(SwarmConversation c) {
    _target = null;
    _attachNote.value = null;
    _sessionNote.value = null;
    if (_scroll.hasClients && _scroll.offset > 0) _toFoot();
    unawaited(_post(c));
  }

  /// Sends [c]'s draft, or its post not confirmed again. Once the backend
  /// took it the keyboard goes down, unless the next message is already being
  /// typed; a post refused or not confirmed keeps it up, to send again.
  Future<void> _post(SwarmConversation c) async {
    final sent = await c.send();
    final started = c.takeStartedSession();
    if (sent && mounted && _conversation == c && c.draft.isEmpty) {
      _focus.unfocus();
    }
    // A message that started a session opens its thread: it answers there.
    if (sent && started != null && mounted && _conversation == c) {
      _openThread(c, started);
    }
  }

  /// Sends [post], not confirmed, again from where it shows; taken, the
  /// keyboard goes down as after Send.
  Future<void> _retry(SwarmConversation c, SwarmPost post) async {
    final sent = await c.retry(post);
    if (sent && mounted && _conversation == c && c.draft.isEmpty) {
      _focus.unfocus();
    }
  }

  void _reply(SwarmConversation c, SuperTabMessage message) {
    c.replyingTo = message;
    setState(() => _acting = null);
    _focus.requestFocus();
  }

  /// Opens [root]'s thread of [c] over the chat, full screen.
  void _openThread(
    SwarmConversation c,
    String root, {
    SwarmThreadFocus? focus,
  }) {
    if (_acting != null) setState(() => _acting = null);
    _focus.unfocus();
    unawaited(
      Navigator.of(context).push(
        phoneRoute(
          (_) => SwarmFiles(
            reader: c.reader,
            child: SwarmThreadPage(
              swarmId: widget.swarmId,
              chat: c,
              root: root,
              focus: focus,
              title: _view.value?.title,
              row:
                  (
                    t,
                    m, {
                    required grouped,
                    required acting,
                    required lit,
                    required followed,
                    required match,
                    required onTap,
                  }) => _threadRow(
                    c,
                    t,
                    m,
                    grouped: grouped,
                    acting: acting,
                    lit: lit,
                    followed: followed,
                    match: match,
                    onTap: onTap,
                  ),
              pending: (t, post) => _threadPending(c, t, post),
            ),
          ),
          listensForItself: true,
        ),
      ),
    );
  }

  void _openNumberedConversation(SwarmConversation c, String id) {
    final reader = _session?.inbox.reader(c.reader.tabId);
    if (mounted && swarmCanOpenNumberedConversation(reader, id)) {
      openSwarmConversation(context, widget.swarmId, id);
    }
  }

  ({Map<int, String> references, String key}) _numberedReferences(
    SwarmConversation c,
    String text,
  ) {
    final numbers = _conversationReferencePattern
        .allMatches(text)
        .map((match) => int.tryParse(match[1]!))
        .whereType<int>()
        .toSet();
    final reader = _session?.inbox.reader(c.reader.tabId);
    final references = swarmNumberedReferences(reader, text);
    return (
      references: references,
      key: [for (final number in numbers) '$number:${references[number] ?? ''}']
          .join(','),
    );
  }

  /// One of thread [t]'s messages as the chat draws its own, less what only
  /// the chat has: no quote, no thread line, no Reply (the box is the reply).
  Widget _threadRow(
    SwarmConversation c,
    SwarmThread t,
    SuperTabMessage m, {
    required bool grouped,
    required bool acting,
    required bool lit,
    required bool followed,
    required bool match,
    required VoidCallback onTap,
  }) {
    final view = _view.value;
    if (view == null) return const SizedBox.shrink();
    final pm = swarmIsPmLine(c.reader, m);
    return SwarmMessageRow(
      key: ValueKey('swarm-thread-message-${m.id}'),
      message: m,
      name: _nameOf(c, m),
      look: _lookOf(c, m),
      role: m.fromAgent && !pm ? view.roles[m.authorId] : null,
      pm: m.fromAgent && view.leads.contains(m.authorId),
      mentions: view.mentions,
      tagged: _taggedOf(c, m).keys.toList(),
      taggedAddresses: _taggedOf(c, m),
      taggedLabels: _labelsOf(c, m),
      readerId: c.reader.accountId,
      references: _numberedReferences(c, m.text).references,
      onOpenConversation: (id) => _openNumberedConversation(c, id),
      grouped: grouped,
      lit: lit,
      followed: followed,
      match: match,
      quote: null,
      actions: acting,
      onTap: onTap,
      onReply: null,
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
        reactions: c.reactionsOf(m),
        readerId: c.reader.accountId,
        nameOf: (kind, id) => _reactorName(c, kind, id),
        onReact: view.canPost ? (emoji) => unawaited(t.react(m, emoji)) : null,
      ),
      links: switch (_session) {
        final session? => _linkPreviews(session, c, m, inThread: true),
        null => null,
      },
      onLongPress: () => unawaited(_pickThreadReaction(c, t, m.id)),
    );
  }

  /// The person's reply [post] on its way in thread [t].
  Widget _threadPending(SwarmConversation c, SwarmThread t, SwarmPost post) {
    final mine = t.messages.reversed
        .where((m) => !m.fromAgent && m.authorId == c.reader.accountId)
        .firstOrNull;
    return KeyedSubtree(
      key: ValueKey('swarm-thread-pending-${post.operationId}'),
      child: _Pending(
        key: const ValueKey('swarm-thread-pending'),
        name: mine == null ? 'You' : _nameOf(c, mine),
        look:
            c.reader.snapshot?.personLook(c.reader.accountId) ??
            (picture: null, status: null),
        text: post.text,
        files: post.files,
        voice: post.voice,
        mentions: _view.value?.mentions ?? SwarmMentions(const []),
        state: post.state,
        quote: null,
        onSendAgain: () => unawaited(t.retry(post)),
        onDelete: () => t.deletePost(post),
      ),
    );
  }

  /// How many earlier pages a quote's original is looked for in: as many as
  /// a tag opens through on the desktop.
  static const _findPages = 50;

  /// The thread the chat opens with, until its first jump
  /// ([SwarmConversationPage.threadId]).
  late String? _threadAt = widget.threadId;
  late SwarmThreadFocus? _threadFocusAt = widget.threadFocus;

  /// Brings [messageId] into view and lights it — read in from earlier pages
  /// when it is further back — or says why it cannot.
  Future<void> _jumpTo(SwarmConversation c, String messageId) async {
    if (_finding) return;
    // Only the jump the chat opened with opens [SwarmConversationPage.threadId]:
    // a quote of the root tapped later brings the root into view.
    final thread = _threadAt, focus = _threadFocusAt;
    _threadAt = null;
    _threadFocusAt = null;
    final landing = _land();
    setState(() {
      _finding = true;
      _note = null;
    });
    // Read back page by page with no redraw between them: the chat is drawn
    // once, with the original among the messages.
    final found = await c.readBackTo(messageId, pages: _findPages);
    if (!mounted || _conversation != c) return;
    // A thread reply opens its thread; one shown only there has no row in
    // the chat to bring into view (the desktop's tag and notice rule).
    final target = found
        ? c.messages.where((m) => m.id == messageId).firstOrNull
        : null;
    // Threads opens the thread itself, its root read back or not, while the
    // chat is still one the reader may read.
    if (thread == messageId &&
        !c.reader.accessRevoked &&
        c.reader.snapshot?.conversation(c.id) != null) {
      _openThread(c, messageId, focus: focus);
    } else if (target != null && target.threadReply) {
      _openThread(
        c,
        target.thread!,
        focus: SwarmThreadFocus.message(messageId),
      );
      if (!target.inMainStream) {
        setState(() => _finding = false);
        if (!_scroll.hasClients || _scroll.offset <= _readingBack) {
          c.heldAt = null;
        }
        return _landed(landing);
      }
    }
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
      return _landed(landing);
    }
    _reveal(c, messageId, 0, landing: landing);
    _litTimer?.cancel();
    setState(() => _lit = messageId);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
  }

  /// The list builds only the rows near what is shown: it jumps near the
  /// target by its place in the list until its row is built, then brings it
  /// to the middle (the desktop's `_revealTarget`).
  void _reveal(
    SwarmConversation c,
    String messageId,
    int attempt, {
    int? landing,
  }) {
    final jump = landing ?? _land();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_target != messageId) return _landed(jump);
      if (_targetKey.currentContext case final row?) {
        unawaited(
          Scrollable.ensureVisible(
            row,
            alignment: 0.5,
            duration: const Duration(milliseconds: 250),
          ).whenComplete(() => _landed(jump)),
        );
        return;
      }
      final shown = _shown;
      final index = shown.indexWhere(
        (entry) => entry is _MessageEntry && entry.message.id == messageId,
      );
      if (!_scroll.hasClients || index < 0 || attempt > 20) {
        return _landed(jump);
      }
      _scroll.position.jumpTo(_offsetNear(index));
      _reveal(c, messageId, attempt + 1, landing: jump);
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
        // Under a project's header, which keeps clear of the status bar.
        top: widget.header,
        child: session == null
            ? Align(
                alignment: Alignment.topLeft,
                child: widget.header
                    ? TtyBackButton(
                        onPressed: () => Navigator.of(context).maybePop(),
                      )
                    : null,
              )
            : c == null
            ? _unopened(context, session, tty)
            : SwarmFiles(
                reader: c.reader,
                child: ValueListenableBuilder(
                  valueListenable: _view,
                  builder: (context, view, _) =>
                      _page(context, session, c, view!, tty),
                ),
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
        if (widget.header)
          _header(context, tty, title: inbox.loaded ? 'Chat' : null),
        Expanded(
          child: inbox.loaded
              ? _said(_notOpen)
              : error != null
              ? _said(error)
              : const SwarmChatSkeleton(),
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

  /// The back button, then the chat's name and [subtitle] under it — its
  /// project, or its Swarm — or, while the chat is not known yet ([title]
  /// null), placeholders of their size — and [action] at its end.
  Widget _header(
    BuildContext context,
    Tty tty, {
    required String? title,
    String? subtitle,
    Widget? action,
    SwarmBuddyMark? mark,
  }) => Padding(
    key: const ValueKey('swarm-chat-header'),
    padding: EdgeInsets.fromLTRB(
      widget.tabRoot ? AppSpace.screenInset : 0,
      AppSpace.xs,
      _headerEnd,
      AppSpace.xs,
    ),
    child: Row(
      children: [
        if (!widget.tabRoot)
          TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
        if (mark != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(end: AppSpace.s),
            child: Semantics(
              label: 'Buddy ${mark.label}',
              child: SwarmBuddyDot(
                mark,
                key: const ValueKey('swarm-buddy-dot'),
              ),
            ),
          ),
        Expanded(
          child: _switchOnTitle(
            title,
            subtitle,
            title == null
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
                      if (subtitle != null)
                        Text(
                          subtitle,
                          key: const ValueKey('swarm-subtitle'),
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

  /// The Buddy tab's title, with several Swarms to switch between: a tap on
  /// it opens the switcher, as Home's title does (Tony, 2026-11-03); the
  /// menu's Swarm row stays, and a screen reader hears [subtitle] with the
  /// title. [words] alone otherwise.
  Widget _switchOnTitle(String? title, String? subtitle, Widget words) {
    final swarm = widget.swarmSwitch;
    if (!widget.tabRoot || swarm == null || title == null) return words;
    return Semantics(
      button: true,
      label: '${subtitle == null ? title : '$title, $subtitle'}. Switch Swarm',
      excludeSemantics: true,
      onTap: swarm.open,
      child: InkWell(
        key: const ValueKey('swarm-buddy-title-switch'),
        borderRadius: BorderRadius.circular(AppCard.insetRadius),
        onTap: swarm.open,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Align(alignment: Alignment.centerLeft, child: words),
        ),
      ),
    );
  }

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
      if (widget.header)
        ListenableBuilder(
          listenable: c,
          builder: (context, _) => _header(
            context,
            tty,
            title: view.known || c.state == SwarmChatState.lost
                ? view.title
                : null,
            subtitle: view.project ?? view.swarm,
            mark: widget.tabRoot ? swarmBuddyMark(c.reader) : null,
            // The person's own Buddy chat: its Notifications, Rename Buddy,
            // Remove Buddy. Any other chat: its Notifications (the desktop's
            // chat menu).
            action: switch (_buddy) {
              final buddy? => SwarmBuddyMenuButton(
                actions: buddy,
                chatId: widget.conversationId,
                onFind: _openFind,
                swarmId: widget.swarmId,
                swarmSwitch: widget.swarmSwitch,
              ),
              null => SwarmChatMenuButton(
                reader: c.reader,
                chatId: c.id,
                onFind: _openFind,
              ),
            },
          ),
        ),
      if (_find case final find?) SwarmFindBar(find: find, onClose: _closeFind),
      if (_buddy case final buddy?) SwarmBuddyBar(actions: buddy),
      // The composer takes what it needs, up to all of the room under the
      // header: on a short phone with the keyboard up its field gives up lines
      // before anything overflows; the messages have the rest.
      Expanded(
        child: LayoutBuilder(
          builder: (context, below) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: ListenableBuilder(
                        // Message links can target any conversation in the
                        // Swarm, not only this chat. Rebuild when that index
                        // changes even if this chat's messages did not.
                        listenable: Listenable.merge([c, session.inbox, _held]),
                        builder: (context, _) =>
                            _messages(context, session, c, view, tty),
                      ),
                    ),
                    // At the top of the list, as Jump to latest is at its foot: the
                    // two can show at once.
                    Positioned(
                      left: 0,
                      right: 0,
                      top: 8,
                      child: ListenableBuilder(
                        listenable: Listenable.merge([c, _offersUnread]),
                        builder: (context, _) =>
                            _offersUnread.value &&
                                c.state != SwarmChatState.lost &&
                                c.stream.isNotEmpty
                            ? Center(
                                child: SwarmJumpToUnreadPill(
                                  onTap: _jumpToFirstUnread,
                                ),
                              )
                            : const SizedBox.shrink(),
                      ),
                    ),
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 8,
                      child: ListenableBuilder(
                        listenable: Listenable.merge([c, _held, _farBack]),
                        builder: (context, _) => switch (_waiting(c)) {
                          0
                              when !_farBack.value ||
                                  c.state == SwarmChatState.lost =>
                            const SizedBox.shrink(),
                          final count => Center(
                            child: SwarmNewPill(count: count, onTap: _toFoot),
                          ),
                        },
                      ),
                    ),
                  ],
                ),
              ),
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: below.maxHeight),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ListenableBuilder(
                      listenable: c,
                      builder: (context, _) {
                        final note = _finding
                            ? 'Finding the original message…'
                            : _note;
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
                                  style: swarmChatText(
                                    13.5,
                                    color: AppPalette.textSecondary,
                                  ),
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
                    if (view.decisionsAside.isNotEmpty)
                      Padding(
                        key: const ValueKey('swarm-decisions-aside'),
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpace.l,
                        ),
                        child: Row(
                          children: [
                            Text(
                              view.decisionsAside.length == 1
                                  ? '1 decision set aside'
                                  : '${view.decisionsAside.length} decisions set aside',
                              style: swarmChatText(
                                13.5,
                                color: AppPalette.textSecondary,
                              ),
                            ),
                            SwarmButton(
                              key: const ValueKey('swarm-decisions-show'),
                              label: 'Show',
                              style: SwarmButtonStyle.link,
                              onPressed: () => _session?.home.setDecisionsAside(
                                c.reader.tabId,
                                view.decisionsAside,
                                aside: false,
                              ),
                            ),
                          ],
                        ),
                      ),
                    if (view.old)
                      Padding(
                        key: const ValueKey('swarm-old-chat'),
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpace.l,
                          vertical: AppSpace.s,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                'Old chat, kept to read.',
                                style: swarmChatText(
                                  13.5,
                                  color: AppPalette.textSecondary,
                                ),
                              ),
                            ),
                            if (swarmCanWrite(c.reader) ||
                                swarmBuddyChat(c.reader, swarmBuddyKey) != null)
                              SwarmButton(
                                key: const ValueKey(
                                  'swarm-old-chat-open-buddy',
                                ),
                                label: 'Open Buddy',
                                style: SwarmButtonStyle.link,
                                onPressed: () => _openBuddy(c),
                              ),
                          ],
                        ),
                      )
                    else if (view.canPost)
                      Flexible(
                        child: ListenableBuilder(
                          listenable: Listenable.merge([c.composer, _voice]),
                          builder: (context, _) => _composer(
                            c,
                            tty,
                            hint: view.hint,
                            buddy: view.buddyProject != null,
                          ),
                        ),
                      )
                    else if (view.known)
                      Padding(
                        padding: const EdgeInsets.all(AppSpace.l),
                        child: Text(
                          view.archived
                              ? 'This chat is archived.'
                              : 'You can read this chat, not post in it.',
                          key: const ValueKey('swarm-read-only'),
                          style: swarmChatText(
                            13.5,
                            color: AppPalette.textSecondary,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ],
  );

  /// From an old chat, back to the person's one Buddy: the Buddy tab, in this
  /// Swarm, with what covered it gone; its chat as its own page with no tabs
  /// up.
  void _openBuddy(SwarmConversation c) {
    final session = _session;
    if (session == null) return;
    final show = session.showBuddyTab;
    if (show == null) {
      unawaited(
        openSwarmBuddy(context, c.reader, widget.swarmId, swarmBuddyKey),
      );
      return;
    }
    session.home.showBuddy(widget.swarmId);
    Navigator.of(context).popUntil((route) => route.isFirst);
    show();
  }

  /// Opens [projectId]'s chat with [pmId] mentioned in its draft: the PM's
  /// private line answered where the PM reads, and everyone with it.
  void _answerIn(String projectId, String pmId) => openSwarmProject(
    context,
    swarmId: widget.swarmId,
    projectId: projectId,
    mention: pmId,
  );

  /// [m]'s author as a quote names them: the person's own messages are
  /// "You".
  String _quoted(SwarmConversation c, SuperTabMessage m) =>
      !m.fromAgent && m.authorId == c.reader.accountId ? 'You' : _nameOf(c, m);

  /// [m]'s author by name; in the person's own Buddy chat the PM's private
  /// lines read as lines to them, "River (PM) → you": the PM writes there but
  /// cannot read it (#2090).
  /// The people [m] tags: each one's address by their username, as the
  /// server names them; an older server's member without one goes by their
  /// email name.
  static Map<String, String> _taggedOf(
    SwarmConversation c,
    SuperTabMessage m,
  ) => {
    if (m.mentions.isNotEmpty)
      for (final person in c.reader.snapshot?.people ?? <SuperTabPerson>[])
        if (m.mentions.contains(person.id)) person.username: person.email,
  };

  /// The names the tag pills of [m] read: each tagged person who set a name,
  /// by their username. The text keeps `@username`; only the pill shows the
  /// name.
  static Map<String, String> _labelsOf(
    SwarmConversation c,
    SuperTabMessage m,
  ) => {
    if (m.mentions.isNotEmpty)
      for (final person in c.reader.snapshot?.people ?? <SuperTabPerson>[])
        if (m.mentions.contains(person.id) && person.name != null)
          person.username: person.name!,
  };

  /// The open task's steps, each read on its own, merged into its chat (task
  /// steps design): a step keeps its own conversation.
  final _steps = <String, SwarmConversation>{};

  /// The merged chat, the same list while no row changed, so the timeline is
  /// not made again on every build (final review, minor 8).
  final _merge = SuperTabStepsMerge();

  void _stepsMoved() {
    if (mounted) setState(() {});
  }

  /// Opens a reader for each step the task has now, and closes those it no
  /// longer has.
  void _syncSteps(SwarmConversation c) {
    final snapshot = c.reader.snapshot;
    final task = snapshot?.conversation(c.id);
    final wanted = snapshot == null || task == null
        ? const <String>{}
        : {for (final step in superTabStepsOf(snapshot, task)) step.id};
    for (final id in [..._steps.keys]) {
      if (wanted.contains(id)) continue;
      _steps.remove(id)!
        ..removeListener(_stepsMoved)
        ..dispose();
    }
    for (final id in wanted) {
      if (_steps.containsKey(id)) continue;
      final step = _steps[id] = SwarmConversation(c.reader, id, shown: false)
        ..addListener(_stepsMoved);
      unawaited(step.load());
    }
  }

  String _nameOf(SwarmConversation c, SuperTabMessage m) {
    final named = c.reader.snapshot?.authorName(m) ?? m.authorName;
    // A step's row in its task's chat names its step (task steps design).
    final group = c.reader.snapshot?.conversation(m.conversationId);
    final name = group != null && superTabIsStep(group)
        ? '$named · ${superTabStepName(group)}'
        : named;
    if (!swarmIsPmLine(c.reader, m)) return name;
    // The coordinator's own badge, whatever its role is called.
    final badge = c.reader.snapshot?.roleOf(m.authorId)?.badge ?? 'PM';
    return '$name ($badge) → you';
  }

  SwarmLook _lookOf(SwarmConversation c, SuperTabMessage m) =>
      c.reader.snapshot?.authorLook(m) ?? (picture: null, status: null);

  static SwarmLook _agentLook(SuperTabAgent? agent) =>
      (picture: agent?.avatar, status: null);

  /// Who gave a reaction, by name and never by email: "You", an agent's
  /// name, another person's shown name.
  String _reactorName(SwarmConversation c, String kind, String id) {
    if (kind == 'person' && id == c.reader.accountId) return 'You';
    final snapshot = c.reader.snapshot;
    if (kind == 'agent') return snapshot?.agentName(id) ?? 'Agent';
    final person = snapshot?.people.where((p) => p.id == id).firstOrNull;
    return person?.shownName ??
        (person == null ? 'Someone' : superTabPersonName(person.email));
  }

  /// The reaction picker over thread [t]'s message [id], as [_pickReaction]
  /// does in the chat.
  Future<void> _pickThreadReaction(
    SwarmConversation c,
    SwarmThread t,
    String id,
  ) async {
    SuperTabMessage? shown() => t.messages.where((m) => m.id == id).firstOrNull;
    final message = shown();
    if (message == null) return;
    final mine = c.mayChange(message);
    final emoji = await showSwarmReactionPicker(
      context,
      reactions: c.reactionsOf(message),
      readerId: c.reader.accountId,
      react: c.canPost,
      link: _linkTo(c, id),
      onEdit: mine && !_isVoice(message)
          ? () => unawaited(_edit(shown, (m, text) => t.editMessage(m, text)))
          : null,
      onDelete: c.mayDelete(message)
          ? () => unawaited(_delete(shown, t.deleteMessage))
          : null,
    );
    if (emoji == null || !mounted) return;
    if (shown() case final now?) await t.react(now, emoji);
  }

  /// Whether [message] is a voice message: its text is its words, never
  /// opened to edit, as they are never shown (anh Dee, 2026-11-04). Delete
  /// stays.
  static bool _isVoice(SuperTabMessage message) =>
      message.attachments.any((file) => file.voice != null);

  /// Edit message on the message [shown] finds: its text in a sheet, and the
  /// new text through [edit]. A refusal says why at the foot; the old text
  /// stays.
  Future<void> _edit(
    SuperTabMessage? Function() shown,
    Future<String?> Function(SuperTabMessage, String) edit,
  ) async {
    final message = shown();
    if (message == null) return;
    final text = await showSwarmEditMessage(
      context,
      text: message.text,
      hasFiles: message.attachments.isNotEmpty,
    );
    if (text == null || !mounted) return;
    final now = shown();
    if (now == null) return;
    _refusal(await edit(now, text));
  }

  /// Delete message on the message [shown] finds, once the person says so.
  Future<void> _delete(
    SuperTabMessage? Function() shown,
    Future<String?> Function(SuperTabMessage) delete,
  ) async {
    if (!await confirmSwarmDeleteMessage(context) || !mounted) return;
    final now = shown();
    if (now == null) return;
    _refusal(await delete(now));
  }

  /// A change's refusal at the foot of the screen; nothing once it went.
  void _refusal(String? refused) {
    if (refused == null || !mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(refused), duration: Durations.extralong4),
    );
  }

  /// The reaction picker over message [id]: the pick reacts to the message
  /// as it is by then. The long-press sheet also copies the message's link;
  /// the Add reaction chip's ([link] false) offers reactions alone.
  Future<void> _pickReaction(
    SwarmConversation c,
    String id, {
    bool link = true,
  }) async {
    SuperTabMessage? shown() => c.messages.where((m) => m.id == id).firstOrNull;
    final message = shown();
    if (message == null) return;
    // Edit and Delete are the long-press sheet's, on the person's own.
    final mine = link && c.mayChange(message);
    final emoji = await showSwarmReactionPicker(
      context,
      reactions: c.reactionsOf(message),
      readerId: c.reader.accountId,
      react: c.canPost,
      link: link ? _linkTo(c, id) : null,
      onEdit: mine && !_isVoice(message)
          ? () => unawaited(_edit(shown, c.editMessage))
          : null,
      onDelete: link && c.mayDelete(message)
          ? () => unawaited(_delete(shown, c.deleteMessage))
          : null,
    );
    if (emoji == null || !mounted) return;
    if (shown() case final now?) await c.react(now, emoji);
  }

  /// Message [id]'s link, the one Desktop copies.
  SwarmMessageLink _linkTo(SwarmConversation c, String id) => SwarmMessageLink(
    tabId: c.reader.tabId,
    conversationId: c.id,
    messageId: id,
  );

  /// The quote of [replyTo] in [conversationId] when the chat has not read
  /// it: the original read by itself ([SwarmReadQuote]).
  Widget _readQuote(
    SwarmSession session,
    SwarmConversation c,
    String conversationId,
    String replyTo, {
    Key? key,
    VoidCallback? onTap,
  }) => SwarmReadQuote(
    key: key,
    reads: session.messageReads,
    reader: c.reader,
    link: SwarmMessageLink(
      tabId: c.reader.tabId,
      conversationId: conversationId,
      messageId: replyTo,
    ),
    author: (original) => _quoted(c, original),
    onTap: onTap,
  );

  /// The previews of the message links [m] says, under it; null when it
  /// says none. A link into another of the account's Swarms is read with
  /// that Swarm's reader; one into a Swarm the account does not list is
  /// unavailable.
  Widget? _linkPreviews(
    SwarmSession session,
    SwarmConversation c,
    SuperTabMessage m, {
    bool inThread = false,
  }) {
    final links = SwarmMessageLink.allIn(m.text);
    if (links.isEmpty) return null;
    final tabId = c.reader.tabId;
    return SwarmLinkPreviews(
      key: ValueKey('swarm-link-previews-${m.id}'),
      links: links,
      reads: session.messageReads,
      reread: c.reader.reads,
      readerOf: (id) => id == tabId ? c.reader : session.inbox.reader(id),
      tabId: tabId,
      chatId: m.conversationId,
      held: (link) => link.tabId == tabId && link.conversationId == c.id
          ? c.messages.where((held) => held.id == link.messageId).firstOrNull
          : null,
      onOpen: (link) => _openLink(c, link, inThread: inThread),
    );
  }

  /// Opens the message [link] points at: brought into view and lit when it
  /// is in this chat, else its chat over this one, at it, which says what it
  /// cannot show. From a thread it always opens its chat over the thread.
  void _openLink(
    SwarmConversation c,
    SwarmMessageLink link, {
    bool inThread = false,
  }) {
    if (!mounted) return;
    if (!inThread &&
        link.tabId == c.reader.tabId &&
        link.conversationId == c.id) {
      unawaited(_jumpTo(c, link.messageId));
      return;
    }
    unawaited(
      Navigator.of(context).push(
        swarmChatRoute(
          swarmId: link.tabId,
          conversationId: link.conversationId,
          messageId: link.messageId,
        ),
      ),
    );
  }

  /// What [c]'s list draws, oldest first ([rows]): its main stream, a reply
  /// only in its thread showing there alone, with a task's steps' rows merged
  /// in by time (task steps design) ([stream]); less the prompt warnings
  /// already [answered].
  ({
    List<SuperTabMessage> stream,
    Set<String> answered,
    List<SuperTabMessage> rows,
  })
  _drawnOf(SwarmConversation c) {
    final snapshot = c.reader.snapshot;
    final stream = _steps.isEmpty
        ? c.stream
        : _merge.of(c.stream, {
            for (final MapEntry(:key, :value) in _steps.entries)
              key: value.stream,
          });
    final answered = answeredPromptAlerts(
      stream,
      (agentId) => snapshot?.agent(agentId),
    );
    final rows = answered.isEmpty
        ? stream
        : [
            for (final m in stream)
              if (!answered.contains(m.id)) m,
          ];
    return (stream: stream, answered: answered, rows: rows);
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
    if (c.stream.isEmpty && c.outgoing.isEmpty) {
      if (state != SwarmChatState.loaded) {
        // A first read that failed: said under the chat once it is known,
        // here until then.
        if (c.error case final error?) {
          return view.known ? const SizedBox.shrink() : _said(error);
        }
        return const SwarmChatSkeleton();
      }
      if (view.decisions.isEmpty) {
        // A Personal project with no Lead offers to start one, as Desktop's
        // empty chat does (task #2941).
        if (SwarmScope.computersOf(context)
            case final SwarmLeadComputers computers
            when swarmWantsLeadStart(c.reader, c.id)) {
          return Align(
            alignment: Alignment.topCenter,
            child: Padding(
              padding: const EdgeInsets.all(AppSpace.screenInset),
              child: SwarmLeadStartCard(
                reader: c.reader,
                computers: computers,
                chatId: c.id,
              ),
            ),
          );
        }
        return _said(
          'No messages yet.',
          key: const ValueKey('swarm-chat-empty'),
        );
      }
    }
    final snapshot = c.reader.snapshot;
    final (:stream, :answered, rows: messages) = _drawnOf(c);
    // The notes hidden are part of what the rows were made from: a warning
    // goes once its agent's prompt is answered, with no new message.
    final from = (
      stream,
      view.decisions,
      c.hasOlder,
      _held.value,
      answered.join(','),
      _lineAt,
      // A reply can move a row's tag, and so its grouping, with no new row.
      [
        for (final m in messages)
          if (c.thread(m.id)?.askTag != null) m.id,
      ].join(','),
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
      _shown = _timeline(
        shown,
        asks,
        hasOlder: c.hasOlder,
        tagged: (m) => c.thread(m.id)?.askTag != null,
        lineAt: _lineAt,
      ).reversed.toList();
      // Every message read, for the quotes.
      _byId = {for (final m in c.messages) m.id: m};
      _placeOf = {for (final (i, entry) in _shown.indexed) _keyOf(entry): i};
      _rows.removeWhere((key, _) => !_placeOf.containsKey(key));
      _madeFrom = from;
      _refreshFindSoon();
    }
    final entries = _shown;
    final byId = _byId;
    // Newest at the foot: the list runs bottom up.
    final pending = c.outgoing.reversed.toList();
    // A page shorter than the screen never scrolls: look once it is drawn.
    if (c.hasOlder && !_loadingOlder && !_olderFailed && !_findReading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _nearTop();
      });
    }
    final lead = pending.length;
    final latestOwn = c.latestOwn;

    Widget entry(_Entry entry) {
      final key = _keyOf(entry);
      switch (entry) {
        case _LineEntry():
          return _row(key, const (), () => SwarmNewMessagesLine(key: _lineKey));
        case _DayEntry(:final day):
          final today = DateUtils.dateOnly(DateTime.now());
          return _row(key, (day, today), () => _Day(day: day, today: today));
        case _MessageEntry(message: final m, :final grouped):
          // A thread reply quotes nothing: it sits under its root, and one
          // also sent here says so and opens the thread.
          final reply = m.replyTo == null || m.threadReply
              ? null
              : byId[m.replyTo];
          final root = m.thread;
          final line = root == m.id ? c.thread(m.id) : null;
          final faces = line == null
              ? const <SwarmThreadFace>[]
              : swarmThreadFaces(snapshot, line);
          final name = _nameOf(c, m);
          final look = _lookOf(c, m);
          final pm = swarmIsPmLine(c.reader, m);
          // "River (PM) → you" says the role already.
          final role = m.fromAgent && !pm ? view.roles[m.authorId] : null;
          // The coordinator's face, whatever its role is called.
          final coordinator = m.fromAgent && view.leads.contains(m.authorId);
          // The PM cannot read this chat: its line is answered in the
          // project chat, where everyone reads it (Tony, mockup A, 10-29).
          final answerIn = pm && view.canPost ? view.buddyProject : null;
          final quoted = reply == null ? null : _quoted(c, reply);
          final tagged = _taggedOf(c, m);
          final labels = _labelsOf(c, m);
          final lit = _lit == m.id, followed = _target == m.id;
          final match = _find?.matching.contains(m.id) ?? false;
          final acting = _acting == m.id;
          final reactions = c.reactionsOf(m);
          final receipt =
              m.id == latestOwn?.id &&
              // Sent to nobody: where no Lead runs, the line says so.
              (m.receiptDelivery == null ||
                  const {
                    'queued',
                    'uncertain',
                  }.contains(m.receiptDelivery?.status));
          // A card's facts are its group's: only a reader of the group has
          // them, and a change to them draws the row again.
          final group = c.conversation;
          final card = snapshot == null || group == null
              ? null
              : SwarmCardFacts.of(snapshot, group, m.id);
          final numbered = _numberedReferences(c, m.text);
          final references = numbered.references;
          return _row(
            key,
            (
              m,
              numbered.key,
              // Drop a cached opener when access to its target changes.
              snapshot?.conversation(
                m.source['taskId'] is String
                    ? m.source['taskId'] as String
                    : '',
              ),
              card,
              name,
              swarmLookKey(look),
              role,
              coordinator,
              grouped,
              lit,
              followed,
              match,
              acting,
              receipt,
              reply,
              quoted,
              view.canPost,
              view.mentions,
              // The highlight follows the reader: a row kept for another
              // account is drawn again.
              c.reader.accountId,
              [for (final e in tagged.entries) '${e.key}:${e.value}'].join(' '),
              [for (final e in labels.entries) '${e.key}:${e.value}'].join(' '),
              reactions,
              answerIn,
              view.project,
              line,
              [
                for (final who in faces)
                  '${who.id}:${who.name}:${who.pm}:${swarmLookKey(who.look)}',
              ].join(','),
            ),
            () => SwarmMessageRow(
              key: followed ? _targetKey : null,
              message: m,
              name: name,
              look: look,
              role: role,
              askTag: line?.askTag,
              pm: coordinator,
              mentions: view.mentions,
              tagged: tagged.keys.toList(),
              taggedAddresses: tagged,
              taggedLabels: labels,
              readerId: c.reader.accountId,
              references: references,
              onOpenConversation: (id) => _openNumberedConversation(c, id),
              grouped: grouped,
              lit: lit,
              followed: followed,
              match: match,
              quote: m.threadReply
                  ? SwarmRepliedInThread(
                      key: ValueKey('swarm-replied-in-thread-${m.id}'),
                      onOpen: () => _openThread(c, root!),
                    )
                  : m.replyTo == null
                  ? null
                  : reply == null
                  ? _readQuote(
                      session,
                      c,
                      m.conversationId,
                      m.replyTo!,
                      key: ValueKey('swarm-quote-${m.id}'),
                      onTap: () => unawaited(_jumpTo(c, m.replyTo!)),
                    )
                  : SwarmQuote(
                      key: ValueKey('swarm-quote-${m.id}'),
                      author: quoted,
                      text: swarmQuoteText(reply),
                      onTap: () => unawaited(_jumpTo(c, m.replyTo!)),
                    ),
              actions: acting,
              onTap: () =>
                  setState(() => _acting = _acting == m.id ? null : m.id),
              // A message with a thread is answered there; one from before
              // threads keeps the inline reply.
              onReply: !view.canPost
                  ? null
                  : root != null
                  ? () => _openThread(c, root)
                  : () => _reply(c, m),
              inThread: root != null,
              card: card == null
                  ? null
                  : SwarmLiveCard(
                      key: ValueKey('swarm-card-${m.id}'),
                      facts: card,
                    ),
              links: _linkPreviews(session, c, m),
              thread: line == null || line.replies == 0
                  ? null
                  : SwarmThreadLine(
                      key: ValueKey('swarm-thread-line-${m.id}'),
                      thread: line,
                      faces: faces,
                      onOpen: () => _openThread(c, m.id),
                    ),
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
                onAdd: widget.homeC && view.canPost
                    ? () => unawaited(_pickReaction(c, m.id, link: false))
                    : null,
              ),
              onLongPress: () => unawaited(_pickReaction(c, m.id)),
              receipt: receipt
                  ? SwarmMessageReceipt(
                      key: ValueKey('swarm-message-receipt-${m.id}'),
                      conversation: c,
                      message: m,
                    )
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
          final coordinator = asker != null && view.leads.contains(asker.id);
          return _row(
            key,
            (
              need,
              grouped,
              asker?.id,
              role,
              coordinator,
              swarmLookKey(_agentLook(asker)),
            ),
            () => _Ask(
              session: session,
              need: need,
              grouped: grouped,
              askerId: asker?.id,
              role: role,
              pm: coordinator,
              picture: asker?.avatar,
            ),
          );
      }
    }

    return ListView.builder(
      key: const ValueKey('swarm-messages'),
      controller: _scroll,
      reverse: true,
      // A finger's scroll only: a new message moving the list leaves it up.
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: _listPadding,
      itemCount: lead + entries.length + (c.hasOlder ? 1 : 0),
      // A row keeps its element when a message or a post moves the others'
      // places.
      findChildIndexCallback: (key) {
        if (key is! ValueKey<String>) return null;
        if (key.value.startsWith(_pendingKey)) {
          final at = pending.indexWhere(
            (p) => '$_pendingKey-${p.operationId}' == key.value,
          );
          return at < 0 ? null : at;
        }
        if (key.value == _olderKey) {
          return c.hasOlder ? lead + entries.length : null;
        }
        final at = _placeOf[key.value];
        return at == null ? null : lead + at;
      },
      itemBuilder: (context, index) {
        if (index < lead) {
          final post = pending[index];
          final reply = post.replyTo == null ? null : byId[post.replyTo];
          final mine = c.messages.reversed
              .where((m) => !m.fromAgent && m.authorId == c.reader.accountId)
              .firstOrNull;
          return _Pending(
            key: ValueKey('$_pendingKey-${post.operationId}'),
            name: mine == null ? 'You' : _nameOf(c, mine),
            look:
                c.reader.snapshot?.personLook(c.reader.accountId) ??
                (picture: null, status: null),
            text: post.text,
            files: post.files,
            voice: post.voice,
            mentions: view.mentions,
            state: post.state,
            quote: post.replyTo == null
                ? null
                : reply == null
                ? _readQuote(session, c, c.id, post.replyTo!)
                : SwarmQuote(
                    author: _quoted(c, reply),
                    text: swarmQuoteText(reply),
                  ),
            onSendAgain: () => unawaited(_retry(c, post)),
            onDelete: () => c.deletePost(post),
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
    _LineEntry() => 'swarm-new-messages-line',
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

  /// How many messages wait below while the person reads back: those the
  /// list will show, not replies only in their thread.
  int _waiting(SwarmConversation c) {
    final held = _held.value;
    if (held == null) return 0;
    final stream = c.stream;
    final at = stream.lastIndexWhere((m) => m.id == held);
    return at < 0 ? 0 : stream.length - at - 1;
  }

  /// Back to the foot, where the messages that waited show.
  void _toFoot() {
    if (!_scroll.hasClients) return;
    final landing = _land();
    unawaited(
      _scroll
          .animateTo(
            0,
            duration: const Duration(milliseconds: 250),
            curve: Curves.easeOut,
          )
          .whenComplete(() => _landed(landing)),
    );
  }

  /// The @ picker while a name is typed, the reply bar while the draft
  /// answers a message, what the last pick left out and what the mic could
  /// not hear, then the card ([SwarmComposerCard]): the files going with the
  /// post, a field that grows with what is typed and its X, and the toolbar —
  /// +, @, the mic and a round Send. While a take is under way the toolbar
  /// is the voice row ([SwarmVoiceRow]), with its own Send, and the picker
  /// and X are hidden. An @
  /// is typed in the field or put there by the @: both open the same picker.
  /// The person's own [buddy] chat has no @ in its toolbar: they talk to
  /// their one Buddy there, and nobody else reads it (Tony, 11-03).
  Widget _composer(
    SwarmConversation c,
    Tty tty, {
    required String hint,
    required bool buddy,
  }) {
    final snapshot = c.reader.snapshot;
    final query = c.mentionQuery;
    final replying = c.replyingTo;
    final voice = _voice;
    final talking = voice?.active ?? false;
    // A post on its way never holds the next back; one not confirmed is sent
    // again from where it shows. Files alone are a post too.
    final canSend = c.canSend;
    final taggable =
        !buddy &&
        snapshot != null &&
        (c.mentionablePeople.isNotEmpty || c.mentionable.isNotEmpty);
    return Padding(
      padding: SwarmComposer.padding,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (query != null && snapshot != null && !talking)
            SwarmMentionPicker(
              people: c.mentionablePeople,
              agents: c.mentionable,
              snapshot: snapshot,
              query: query,
              onPick: (id) {
                c.completeMention(id);
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
                                  ': ${swarmQuoteText(replying).replaceAll(RegExp(r'\s+'), ' ')}',
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
                  SwarmRoundButton(
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
          ValueListenableBuilder(
            valueListenable: _sessionNote,
            builder: (context, note, _) => note == null || talking
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
                      key: const ValueKey('swarm-session-note'),
                      style: AppType.caption(color: tty.yellow),
                    ),
                  ),
          ),
          // Where a session works is the Swarm's one Buddy chat's to pick;
          // a project's own Buddy chat sends no project.
          if (c.newSession &&
              !talking &&
              c.conversation?.isSwarmBuddyChat == true)
            SwarmSessionProjectRow(
              key: const ValueKey('swarm-session-project'),
              chat: c,
              onTap: () => unawaited(showSwarmSessionProjects(context, c)),
            ),
          Flexible(
            child: SwarmComposerCard(
              focus: _focus,
              fit: true,
              chips: c.files.files.isEmpty ? null : SwarmOutgoingChips(box: c),
              field: SwarmMessageField(
                controller: _text,
                focus: _focus,
                hint: hint,
                clearable: !talking,
                imagePaste: swarmSendsFiles
                    ? SwarmImagePaste(
                        enabled: !c.uploading && c.files.room > 0,
                        onImage: (image) => unawaited(_pasteImage(c, image)),
                      )
                    : null,
              ),
              toolbar: talking
                  ? SwarmVoiceRow(voice: voice!)
                  : Row(
                      children: [
                        if (swarmSendsFiles)
                          SwarmAttachButton(
                            key: const ValueKey('swarm-attach'),
                            onTap: c.uploading || c.files.room <= 0
                                ? null
                                : () => unawaited(_pickFiles(c)),
                          ),
                        if (taggable)
                          SwarmTagButton(
                            open: query != null,
                            onTap: () {
                              c.toggleMention();
                              _focus.requestFocus();
                            },
                          ),
                        // The rest of the row: the chip takes what its label
                        // needs, and gives up letters only when the row is full.
                        Expanded(
                          child: c.offersSessions
                              ? Align(
                                  alignment: Alignment.centerLeft,
                                  child: Padding(
                                    padding: const EdgeInsets.only(
                                      left: AppSpace.xs,
                                    ),
                                    child: SwarmNewSessionChip(
                                      on: c.newSession,
                                      blocked: c.sessionBlocked,
                                      onChanged: (on) {
                                        _sessionNote.value = null;
                                        c.newSession = on;
                                      },
                                      onBlocked: () =>
                                          _sessionNote.value = c.sessionBlocked,
                                    ),
                                  ),
                                )
                              : const SizedBox.shrink(),
                        ),
                        if (voice != null) SwarmVoiceMic(voice: voice),
                        SwarmRoundButton(
                          key: const ValueKey('swarm-send'),
                          label: 'Send',
                          face: 36,
                          fill: canSend ? AppPalette.accent : ttyRaised(tty),
                          onTap: canSend ? () => _send(c) : null,
                          child: Icon(
                            LucideIcons.arrowUp,
                            size: 20,
                            color: canSend
                                ? AppInk.onFill
                                : AppPalette.textFaint,
                          ),
                        ),
                      ],
                    ),
            ),
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
    required this.swarm,
    required this.canPost,
    required this.archived,
    required this.old,
    required this.names,
    required this.mentions,
    required this.roles,
    required this.leads,
    required this.mentionable,
    required this.decisions,
    required this.decisionsAside,
    required this.buddyProject,
    required this.hint,
    required this.cards,
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
    // An older Buddy chat, where the Swarm gives one Buddy: kept to read, with
    // no Buddy of its own to start, name or ask (the desktop's).
    final old = group != null && swarmIsOldBuddyChat(reader, group.id);
    // The person's own Buddy chat (#2090): named after their Buddy, and
    // holding every question the PM asked them in its project, as on Desktop;
    // their one chat for the Swarm holds every project's.
    final buddyProject =
        group != null && !old && swarmIsOwnBuddyChat(reader, group.id)
        ? group.projectId
        : null;
    final buddy = buddyProject == null
        ? null
        : swarmBuddyName(reader, buddyProject);
    final project = snapshot?.projects
        .where((p) => p.id == group?.projectId)
        .firstOrNull
        ?.name;
    // The person's one Buddy chat for the Swarm is in no project: its
    // Swarm's name stands under it instead, the Swarm the Buddy tab switches
    // between (Tony, 11-03).
    final swarm = buddyProject == swarmBuddyKey
        ? session.inbox.swarms
              .where((s) => s.id == reader.tabId)
              .firstOrNull
              ?.name
        : null;
    // Only the person's own Buddy chat holds decisions, its project's, as
    // Desktop shows them above it; every other chat leaves them to Activity
    // (Dee, 11-01: they blocked the project chat). A chat not open to the
    // person shows none either, even while the decisions read has not caught
    // up.
    final asked = [
      if (group != null && buddyProject != null)
        for (final need in session.inbox.needs)
          if (need is SwarmDecisionNeed &&
              need.swarmId == reader.tabId &&
              (buddyProject == swarmBuddyKey ||
                  need.decision.projectId == buddyProject))
            need,
    ];
    bool aside(SwarmDecisionNeed need) =>
        session.home.decisionAside(need.swarmId, need.decision.id);
    final decisions = [
      for (final need in asked)
        if (!aside(need)) need,
    ];
    return _ChatView(
      known: group != null,
      title: group == null
          ? 'Chat'
          : old
          ? 'Old chat'
          : buddy ?? group.label,
      project: buddy != null && project != null ? '#$project' : project,
      swarm: swarm,
      canPost: c.canPost,
      archived: group?.archived ?? false,
      old: old,
      names: names,
      mentions: before != null && listEquals(before.names, names)
          ? before.mentions
          : SwarmMentions(names),
      roles: {
        for (final agent in agents)
          agent.id: ?swarmAgentRole(snapshot!, agent.id),
      },
      leads: {
        for (final agent in agents)
          if (snapshot!.isLead(agent.id)) agent.id,
      },
      mentionable: [for (final agent in c.mentionable) agent.id],
      decisions: before != null && _sameAsks(before.decisions, decisions)
          ? before.decisions
          : List.unmodifiable(decisions),
      decisionsAside: [
        for (final need in asked)
          if (aside(need)) need.decision.id,
      ],
      buddyProject: buddyProject,
      // "Message Wren"; plain while no Buddy runs to read it.
      hint: buddyProject != null && swarmBuddy(reader, buddyProject) != null
          ? 'Message $buddy'
          : 'Message',
      cards: snapshot == null || group == null
          ? const {}
          : {
              for (final id in {
                ?group.cards.task,
                for (final pull in group.cards.pullRequests) pull.messageId,
              })
                id: ?SwarmCardFacts.of(snapshot, group, id),
            },
    );
  }

  /// The conversation is in the Swarm's read.
  final bool known;
  final String title;
  final String? project;

  /// The Swarm's name, under the person's one Buddy chat for it; null for any
  /// other chat.
  final String? swarm;
  final bool canPost, archived;

  /// An older Buddy chat, kept to read ([swarmIsOldBuddyChat]).
  final bool old;

  /// The Swarm's agents by name, and the @mentions of them marked in
  /// messages: made again only when a name changed.
  final List<String> names;
  final SwarmMentions mentions;

  /// Each agent's compact role badge, by agent id: the role it goes by, cut
  /// to 12 characters.
  final Map<String, String> roles;

  /// The agents that coordinate a project: they wear manager blue, whatever
  /// their role is called.
  final Set<String> leads;

  /// The agents a post can mention, by id.
  final List<String> mentionable;
  final List<SwarmDecisionNeed> decisions;

  /// The decisions of this Buddy chat set aside with Not now, by id.
  final List<String> decisionsAside;

  /// The project whose Buddy chat of the person's own this is; null for any
  /// other chat.
  final String? buddyProject;

  /// What the empty composer says.
  final String hint;

  /// Each live card's facts by its message's id: a change to the group that
  /// changes a card draws the chat again (its rows make their own from the
  /// messages too).
  final Map<String, SwarmCardFacts> cards;

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
      other.swarm == swarm &&
      other.canPost == canPost &&
      other.archived == archived &&
      other.old == old &&
      listEquals(other.names, names) &&
      mapEquals(other.roles, roles) &&
      setEquals(other.leads, leads) &&
      listEquals(other.mentionable, mentionable) &&
      identical(other.decisions, decisions) &&
      listEquals(other.decisionsAside, decisionsAside) &&
      other.buddyProject == buddyProject &&
      other.hint == hint &&
      mapEquals(other.cards, cards);

  @override
  int get hashCode => Object.hash(
    known,
    title,
    project,
    swarm,
    canPost,
    archived,
    old,
    Object.hashAll(names),
    Object.hashAll(mentionable),
    Object.hashAll(decisionsAside),
    decisions,
    buddyProject,
    hint,
    Object.hashAll(cards.values),
  );
}

/// One row of the chat.
sealed class _Entry {}

/// The New messages line, above the first unread message.
final class _LineEntry extends _Entry {}

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
/// still open is never out of sight behind "Earlier messages". The New
/// messages line goes right above [lineAt], which is then drawn in full, not
/// as a follow-up of the one before.
List<_Entry> _timeline(
  List<SuperTabMessage> messages,
  List<SwarmDecisionNeed> asks, {
  required bool hasOlder,
  required bool Function(SuperTabMessage) tagged,
  String? lineAt,
}) {
  final grouped = swarmGroupedMessages(messages, tagged: tagged);
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
    if (m.id == lineAt) rows.add((_LineEntry(), m.createdAt));
    // Grouped only right under a message: not under a question or the line.
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
Set<String> swarmGroupedMessages(
  List<SuperTabMessage> messages, {
  bool Function(SuperTabMessage)? tagged,
}) {
  bool joins(SuperTabMessage current, SuperTabMessage previous) {
    // A tagged row's header is where its tag shows.
    if (tagged != null && (tagged(current) || tagged(previous))) return false;
    bool plain(SuperTabMessage m) =>
        m.source['kind'] != 'ship' &&
        m.route == null &&
        !m.terminalEvent &&
        m.replyTo == null &&
        m.text.length <= 280 &&
        !m.text.contains('\n') &&
        !m.text.contains('?') &&
        !m.text.contains('？');
    if (!plain(current) ||
        !plain(previous) ||
        current.authorId.isEmpty ||
        current.authorId != previous.authorId ||
        current.terminalNote != previous.terminalNote ||
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

/// An agent's role as its compact badge says it: the role the project's
/// document gives it, cut to 12 characters (an older backend's PM, Rev or
/// Dev); none for a person, a Buddy (Desktop shows it none either), or an
/// agent no longer in the Swarm.
String? swarmRole(SuperTabSnapshot snapshot, SuperTabMessage message) {
  if (!message.fromAgent) return null;
  return swarmAgentRole(snapshot, message.authorId);
}

String? swarmAgentRole(SuperTabSnapshot snapshot, String agentId) =>
    snapshot.roleOf(agentId)?.badge;

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
/// changes height as it breathes. A thread's first read shows it too.
class SwarmChatSkeleton extends StatelessWidget {
  const SwarmChatSkeleton({super.key});

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
    child: ListView.builder(
      key: const ValueKey('swarm-chat-skeleton'),
      // From the foot, as the messages are, the bubbles over and over: any
      // screen is full up to its top, where the last one is cut off.
      reverse: true,
      physics: const NeverScrollableScrollPhysics(),
      padding: _listPadding,
      itemBuilder: (_, i) {
        final (lines, width) =
            _bubbles[(_bubbles.length - 1 - i) % _bubbles.length];
        return _SkeletonBubble(lines: lines, width: width);
      },
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

/// How many messages arrived below while the person read back — or, with
/// none ([count] 0), Jump to latest while they read far back;
/// a tap goes down to the foot. The chat's and a thread's.
class SwarmNewPill extends StatelessWidget {
  const SwarmNewPill({super.key, required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => _JumpPill(
    key: ValueKey(count == 0 ? 'swarm-jump-latest' : 'swarm-new-pill'),
    icon: LucideIcons.arrowDown,
    text: count == 0 ? 'Jump to latest' : '$count new',
    label: count == 0
        ? 'Jump to latest'
        : count == 1
        ? '1 new message'
        : '$count new messages',
    onTap: onTap,
  );
}

/// Shown while the New messages line, not yet seen this visit, is above the
/// view: takes the person up to it (Desktop's `SuperTabJumpToUnread`).
class SwarmJumpToUnreadPill extends StatelessWidget {
  const SwarmJumpToUnreadPill({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => _JumpPill(
    key: const ValueKey('swarm-jump-unread'),
    icon: LucideIcons.arrowUp,
    text: 'Jump to first unread',
    label: 'Jump to first unread',
    onTap: onTap,
  );
}

/// A capsule over the chat that takes the person somewhere in it.
class _JumpPill extends StatelessWidget {
  const _JumpPill({
    super.key,
    required this.icon,
    required this.text,
    required this.label,
    required this.onTap,
  });

  static const double _height = 36;

  final IconData icon;
  final String text, label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
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
              Icon(icon, size: 16, color: AppInk.onFill),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: swarmChatText(
                    14,
                    color: AppInk.onFill,
                    weight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// The person's post on its way, with [SwarmPostLine] under it: "Sending…",
/// then — its answer lost — "Not sent · Retry", until it is read back. One the
/// backend took shows as sent, with no line, until the read that brings it.
class _Pending extends StatelessWidget {
  const _Pending({
    super.key,
    required this.name,
    required this.text,
    required this.files,
    this.voice,
    required this.mentions,
    required this.state,
    required this.quote,
    required this.onSendAgain,
    required this.onDelete,
    required this.look,
  });

  final String name, text;

  /// The files going with it, already uploaded: shown as chips that open
  /// nothing until the post is read back with their links.
  final List<SwarmOutgoingFile> files;

  /// What makes it a voice message, its one file the clip: drawn as its
  /// bubble, which plays once the post is read back.
  final SuperTabVoice? voice;

  /// The person's own face.
  final SwarmLook look;
  final SwarmMentions mentions;
  final SwarmPostState state;
  final Widget? quote;
  final VoidCallback onSendAgain, onDelete;

  @override
  Widget build(BuildContext context) {
    final sending = state == SwarmPostState.sending;
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
        header: SwarmMessageHeader(name: name, agent: false),
        body: [
          ?quote,
          for (final part in swarmTextParts(text))
            if (part.code)
              SwarmCodeBlock(code: part.text, name: part.name)
            else
              Padding(
                padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
                child: Text.rich(
                  mentions.span(
                    part.text,
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
          if (voice case final voice? when files.length == 1)
            SwarmVoiceBubble(
              file: SuperTabAttachment.fromJson({
                'id': '',
                'name': files.single.name,
                'mime': swarmMimeForName(files.single.name),
                'size': files.single.size,
                'url': '',
              }),
              voice: voice,
            )
          else
            for (final file in files)
              SwarmFileChip(
                file: SuperTabAttachment.fromJson({
                  'id': '',
                  'name': file.name,
                  'mime': swarmMimeForName(file.name),
                  'size': file.size,
                  'url': '',
                }),
                link: null,
              ),
          if (state != SwarmPostState.confirmed)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.xs),
              child: SwarmPostLine(
                sending: sending,
                onRetry: onSendAgain,
                onDelete: onDelete,
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
    required this.pm,
    required this.picture,
  });

  final SwarmSession session;

  /// The picture its asker chose.
  final SuperTabAvatarPicture? picture;
  final SwarmDecisionNeed need;
  final bool grouped;

  /// Its asker in the Swarm and their role; null for one no longer in it.
  final String? askerId, role;

  /// Its asker is its project's coordinator, whatever its role is called.
  final bool pm;

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
          pm: pm,
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
                    onNotNow: () => session.home.setDecisionsAside(
                      need.swarmId,
                      [need.decision.id],
                      aside: true,
                    ),
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

/// Over the composer, who the @ being typed can name, as Desktop offers
/// them: the chat's people whose username or shown name holds what follows
/// it (each by the name they show by, `@username` beside one who set a name;
/// a pick still puts in `@username`), then its agents whose name starts with
/// it, each with its role and what it is doing. The chat's and a thread's
/// reply box alike.
class SwarmMentionPicker extends StatelessWidget {
  const SwarmMentionPicker({
    super.key,
    required this.people,
    required this.agents,
    required this.snapshot,
    required this.query,
    required this.onPick,
  });

  final List<SuperTabPerson> people;
  final List<SuperTabAgent> agents;
  final SuperTabSnapshot snapshot;
  final String query;

  /// The person's or agent's id.
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final glances = {
      for (final glance in swarmTeamGlance(snapshot).agents)
        glance.agent.id: glance,
    };
    final prefix = query.toLowerCase();
    final shownPeople = [
      for (final person in people)
        if (person.username.toLowerCase().contains(prefix) ||
            (person.name?.toLowerCase().contains(prefix) ?? false))
          person,
    ];
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
      child: shown.isEmpty && shownPeople.isEmpty
          ? Padding(
              padding: const EdgeInsets.all(AppSpace.l),
              child: Text(
                'No one by that name.',
                style: swarmChatText(14, color: AppPalette.textSecondary),
              ),
            )
          : ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: [
                for (final person in shownPeople)
                  TtyTap(
                    key: ValueKey('swarm-pick-person-${person.id}'),
                    semanticsLabel: person.name == null
                        ? person.username
                        : '${person.name}, @${person.username}',
                    minHeight: 52,
                    onTap: () => onPick(person.id),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.l,
                      ),
                      child: Row(
                        children: [
                          SwarmChatAvatar(
                            name: person.shownName,
                            id: person.id,
                            agent: false,
                            picture: person.avatar,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    person.shownName,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: swarmChatText(
                                      16,
                                      weight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                                // The handle a tag types, beside a name.
                                if (person.name != null) ...[
                                  const SizedBox(width: 6),
                                  Flexible(
                                    child: Text(
                                      '@${person.username}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: swarmChatText(
                                        13,
                                        color: AppPalette.textSecondary,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                for (final agent in shown)
                  TtyTap(
                    key: ValueKey('swarm-pick-${agent.id}'),
                    semanticsLabel: snapshot.agentName(agent.id),
                    minHeight: 52,
                    onTap: () => onPick(agent.id),
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

/// The composer's field inside [SwarmComposerCard]: text that grows with
/// what is typed, 1 to 5 lines and then scrolls, in the app's own face, with
/// an X pinned at its top right that clears the text (Tony, 11-01). A thread's
/// reply box and New message have it too.
class SwarmMessageField extends StatelessWidget {
  const SwarmMessageField({
    super.key,
    required this.controller,
    required this.focus,
    required this.hint,
    this.fieldKey = const ValueKey('swarm-field'),
    this.clearKey = const ValueKey('swarm-field-clear'),
    this.clearable = true,
    this.imagePaste,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final String hint;

  /// Where a picture pasted into the field goes ([swarmFieldMenu]); none
  /// takes text alone.
  final SwarmImagePaste? imagePaste;

  /// The field's key: the chat's, a thread's and New message's are told
  /// apart by it.
  final Key fieldKey;

  /// The X's key.
  final Key clearKey;

  /// Whether the X shows while there is text: not during a take.
  final bool clearable;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Stack(
      children: [
        GestureDetector(
          // A tap anywhere in the field's area — not only on the text — takes
          // the keyboard.
          behavior: HitTestBehavior.opaque,
          onTap: focus.requestFocus,
          child: Container(
            key: fieldKey,
            // The right 44 is always kept for the X, so the text does not
            // rewrap as it comes and goes.
            padding: SwarmComposer.fieldPadding,
            child: TextSelectionTheme(
              data: TextSelectionThemeData(
                cursorColor: AppPalette.accentOnSurface,
                selectionColor: AppPalette.accentOnSurface.withValues(
                  alpha: 0.3,
                ),
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
                // The keyboard's own composing, left on: Vietnamese Telex on
                // iOS rides on autocorrection. See `ComposingKeyboard`.
                autocorrect: ComposingKeyboard.autocorrect,
                enableSuggestions: ComposingKeyboard.enableSuggestions,
                smartDashesType: SmartDashesType.disabled,
                smartQuotesType: SmartQuotesType.disabled,
                contextMenuBuilder: (context, field) =>
                    swarmFieldMenu(context, field, imagePaste),
                contentInsertionConfiguration: switch (imagePaste) {
                  final paste? => ContentInsertionConfiguration(
                    allowedMimeTypes: swarmInsertedImageTypes,
                    onContentInserted: (content) =>
                        paste.onImage(SwarmPastedImage.inserted(content)),
                  ),
                  null => null,
                },
                cursorColor: AppPalette.accentOnSurface,
                cursorWidth: 2,
                style: swarmChatText(16, height: 22 / 16),
                decoration: InputDecoration(
                  isCollapsed: true,
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
        ),
        if (clearable)
          Positioned(
            top: 1,
            right: 0,
            child: ValueListenableBuilder<TextEditingValue>(
              valueListenable: controller,
              builder: (context, value, _) => value.text.isEmpty
                  ? const SizedBox.shrink()
                  : Semantics(
                      button: true,
                      label: 'Clear text',
                      excludeSemantics: true,
                      onTap: controller.clear,
                      child: GestureDetector(
                        key: clearKey,
                        behavior: HitTestBehavior.opaque,
                        // Text only: files and the reply stay, and so do the
                        // focus and the keyboard.
                        onTap: controller.clear,
                        child: SizedBox.square(
                          dimension: 44,
                          child: Center(
                            child: Container(
                              width: 24,
                              height: 24,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: tty.text.withValues(alpha: 0.11),
                                shape: BoxShape.circle,
                              ),
                              child: Icon(
                                LucideIcons.x,
                                size: 14,
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
            ),
          ),
      ],
    );
  }
}

/// The composer as one floating card (Tony, 11-01; Claude and Slack's
/// layout): the files going, the field, then the toolbar. Used by the chat,
/// New message and a thread's reply box. The border darkens while [focus]
/// has the keyboard.
class SwarmComposerCard extends StatelessWidget {
  const SwarmComposerCard({
    super.key,
    this.chips,
    required this.field,
    required this.toolbar,
    required this.focus,
    this.fit = false,
  });

  /// The files going with the post; null while there are none.
  final Widget? chips;

  /// Under a height limit, the field gives up lines first (fewer than five,
  /// then it scrolls): the chat's composer on a short phone with the keyboard
  /// up. Only where the card's parent bounds its height.
  final bool fit;
  final Widget field;
  final Widget toolbar;
  final FocusNode focus;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ListenableBuilder(
      listenable: focus,
      builder: (context, _) => Container(
        key: const ValueKey('swarm-composer-card'),
        decoration: BoxDecoration(
          color: swarmChatCard(tty),
          border: Border.all(
            color: focus.hasFocus
                ? tty.text.withValues(alpha: 0.26)
                : swarmChatHair(tty),
          ),
          borderRadius: BorderRadius.circular(SwarmComposer.cardRadius),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (chips case final chips?)
              Padding(padding: SwarmComposer.chipsPadding, child: chips),
            if (fit) Flexible(child: field) else field,
            Padding(
              padding: SwarmComposer.toolbarPadding,
              child: SizedBox(height: 44, child: toolbar),
            ),
          ],
        ),
      ),
    );
  }
}

/// A round button in a 44pt target: Send, the reply bar's ✕, +. [fill] draws
/// it solid; with [face] the fill is a circle that wide, centred in the 44.
class SwarmRoundButton extends StatelessWidget {
  const SwarmRoundButton({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
    this.fill,
    this.face,
  });

  final String label;
  final VoidCallback? onTap;
  final Widget child;
  final Color? fill;

  /// The visible circle's width; null fills the whole 44.
  final double? face;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: onTap != null,
    label: label,
    // The tap a screen reader sends: the detector's own is left out with
    // what is under the label.
    onTap: onTap,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: switch (face) {
        null => Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
          child: child,
        ),
        final face => SizedBox.square(
          dimension: 44,
          child: Center(
            child: SizedBox.square(
              dimension: face,
              child: DecoratedBox(
                decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
                child: Center(child: child),
              ),
            ),
          ),
        ),
      },
    ),
  );
}

/// A composer's + ([attachSwarmFiles]): off, and faint, while files go up or
/// no more fit.
class SwarmAttachButton extends StatelessWidget {
  const SwarmAttachButton({super.key, required this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => SwarmRoundButton(
    label: 'Attach files',
    onTap: onTap,
    face: 36,
    fill: Tty.of(context).text.withValues(alpha: 0.08),
    child: Icon(
      LucideIcons.plus,
      size: 22,
      color: onTap == null ? AppPalette.textFaint : AppPalette.textSecondary,
    ),
  );
}

/// The composer's @ ([SwarmMentioning.toggleMention]), the chat's and a
/// thread's: ends the draft in an @, which opens the picker, or closes it
/// again while no name is typed. The sign alone on a round face, as + is
/// (Tony, 11-03: the word Tag said nothing more); in the accent while the
/// picker is open.
class SwarmTagButton extends StatelessWidget {
  const SwarmTagButton({super.key, required this.open, required this.onTap});

  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => SwarmRoundButton(
    key: const ValueKey('swarm-tag'),
    label: 'Tag a member or agent',
    onTap: onTap,
    face: 36,
    fill: open
        ? AppPalette.accentOnSurface.withValues(alpha: 0.16)
        : Tty.of(context).text.withValues(alpha: 0.08),
    child: Icon(
      LucideIcons.atSign,
      size: 20,
      color: open ? AppPalette.accentOnSurface : AppPalette.textSecondary,
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
