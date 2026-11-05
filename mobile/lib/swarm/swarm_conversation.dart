import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import 'package:harness_mobile/phone/voice_recorder.dart' show VoiceTake;

import 'model.dart';
import 'prompt_alerts.dart';
import 'swarm_chat_cache.dart';
import 'swarm_buddy.dart' show swarmIsOldBuddyChat;
import 'swarm_buddy_sessions.dart';
import 'swarm_outbox.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_uploads.dart';
import 'swarm_voice_send.dart';

/// One conversation on the phone: its messages and what the person posts to
/// it — the desktop's `SuperTabController` messages and composer, for one
/// conversation at a time.
///
/// Messages are read as the latest page when opened, older pages on demand,
/// and new ones when the Swarm's read says the conversation moved past the
/// last one shown (`lastMessageSequence`): no read of its own while nothing
/// was posted. Keep the [reader] shown while this is on screen. A chat read
/// before shows at once what was read then ([SwarmChatCache]) and reads on
/// from it.
///
/// A conversation the Swarm's read no longer has hides its messages at once
/// and is asked for by id, as a closed one is in no full read; one it never
/// had is asked for while its messages are read. One the person cannot read
/// keeps nothing here: messages, draft and a post not confirmed.
class SwarmConversation extends ChangeNotifier
    with SwarmMentioning
    implements SwarmFilesBox {
  /// [shown] and [heldAt] as they are from the start, so what it kept is
  /// read only as far as it is seen.
  SwarmConversation(
    this.reader,
    this.id, {
    this.uploadTimeout = const Duration(minutes: 2),
    this.sendTimeout = SwarmOutbox.defaultTimeout,
    this._shown = true,
    this._heldAt,
  }) {
    _listed = conversation != null;
    if (SwarmChatCache.take(reader, id) case final kept?) {
      messages = kept.messages;
      _before = kept.before;
      _reactionSeq = kept.reactionSeq;
      _threads.addAll(kept.threads);
      _read = _kept = true;
      _markRead();
    }
    reader.addListener(_swarmChanged);
    reader.reads.addListener(_swarmChanged);
    files.addListener(_filesChanged);
    _composer.addListener(_keepDraft);
    _takeKept();
  }

  /// What a person wrote and has not got through, from before this chat was
  /// opened: its draft, and its posts as Not sent. A read that holds one drops
  /// it ([SwarmOutbox.settle]).
  void _takeKept() {
    final kept = reader.kept;
    if (kept == null || _disposed) return;
    if (!kept.loaded) {
      kept.addListener(_takeKeptOnce);
      return;
    }
    if (_draft.isEmpty) {
      if (kept.draft(reader.tabId, id, null) case final draft?) {
        _draft = _keptDraft = draft.text;
        _mentions.addAll(draft.mentions);
      }
    }
    if (_outbox.isEmpty) {
      final posts = [
        for (final row in kept.posts(reader.tabId, id, null))
          ?SwarmPost.fromKept(row, _heldOf),
      ];
      if (posts.isNotEmpty) _outbox.restore(posts);
    }
    _composer.changed();
  }

  void _takeKeptOnce() {
    reader.kept?.removeListener(_takeKeptOnce);
    _takeKept();
  }

  /// What a kept post puts back in the box if it is refused: only its words.
  static Object? _heldOf(String text) => (
    draft: text,
    mentions: const <String, String>{},
    replyTo: null as SuperTabMessage?,
    newSession: false,
    sessionProjectId: null as String?,
  );

  String _keptDraft = '';

  void _keepDraft() {
    if (_disposed || _refused || _draft == _keptDraft) return;
    _keptDraft = _draft;
    reader.kept?.setDraft(reader.tabId, id, null, _draft, _mentions);
  }

  void _keepPosts() {
    if (_disposed) return;
    reader.kept?.setPosts(reader.tabId, id, null, [
      for (final post in _outbox.posts)
        if (post.state != SwarmPostState.confirmed) post.kept,
    ]);
  }

  /// Takes [post], Not sent, away for good: Delete. It may still have arrived,
  /// and then it shows when the chat is next read.
  void deletePost(SwarmPost post) {
    if (_disposed || post.state != SwarmPostState.unconfirmed) return;
    _uploads.forget(post.files);
    _outbox.remove(post);
    if (error != null && error == _postError && _outbox.unconfirmed == null) {
      error = null;
      _tell();
    }
  }

  @override
  final SwarmReader reader;
  final String id;

  /// How long an upload may go without a byte moving before the send gives up.
  final Duration uploadTimeout;

  /// How long a post waits for its answer before it says Not sent.
  final Duration sendTimeout;

  /// The files waiting to go with the next post. They stay in memory — a
  /// large one on disk, in the app's temporary folder — and go when the chat
  /// closes: only what the person typed is kept, and only while
  /// the chat is open.
  @override
  final files = SwarmOutgoingFiles();

  /// The files of a post are on their way to the backend, before the post.
  bool get uploading => _uploads.uploading;

  late final _uploads = SwarmUploads(
    reader,
    id,
    timeout: uploadTimeout,
    onChanged: () {
      if (!_disposed) _tell();
    },
    onProgress: _composer.changed,
  );

  /// The files waiting to go with each thread's next reply, by its root:
  /// kept with its draft while the chat is open ([SwarmThread]).
  final _threadFiles = <String, SwarmOutgoingFiles>{};

  /// The files waiting to go with [root]'s thread's next reply.
  SwarmOutgoingFiles threadFiles(String root) =>
      _threadFiles.putIfAbsent(root, SwarmOutgoingFiles.new);

  /// [root]'s thread closed: its [box] goes when it holds nothing.
  void releaseThreadFiles(String root, SwarmOutgoingFiles box) {
    if (identical(_threadFiles[root], box) && box.files.isEmpty) {
      _threadFiles.remove(root);
    }
  }

  /// Oldest first: every message read, a reply only in its thread too.
  List<SuperTabMessage> messages = const [];

  /// The [messages] the chat lists: a reply only in its thread shows there
  /// alone ([SuperTabMessage.inMainStream], the desktop's main stream), and
  /// what was typed into a terminal, a gap in its recording or the line of an
  /// instructions save is no row ([SuperTabMessage.terminalPrompt],
  /// [SuperTabMessage.terminalGap], [SuperTabMessage.instructionsSave]).
  List<SuperTabMessage> get stream {
    if (!identical(_streamOf, messages)) {
      _streamOf = messages;
      _stream = List.unmodifiable(
        messages.where(
          (m) =>
              m.inMainStream &&
              !m.terminalPrompt &&
              !m.terminalGap &&
              !m.instructionsSave,
        ),
      );
    }
    return _stream;
  }

  List<SuperTabMessage>? _streamOf;
  List<SuperTabMessage> _stream = const [];

  /// Each thread's line, by its root, as the newest page that named it said
  /// it (the desktop's `_keepThreads`): its replies, who wrote them and when
  /// the last came.
  final _threads = <String, SuperTabThread>{};

  /// [root]'s thread, once a page named it with a reply.
  SuperTabThread? thread(String root) => _threads[root];

  /// Each thread's draft while the chat is open (the desktop's
  /// `threadDraft`), and those it mentions (`threadMentions`): a thread
  /// closed and opened again finds them.
  final _threadDrafts = <String, String>{};
  final _threadMentions = <String, Map<String, String>>{};

  String threadDraft(String root) =>
      _threadDrafts[root] ??
      reader.kept?.draft(reader.tabId, id, root)?.text ??
      '';

  /// Those [root]'s thread's draft mentions, by id with the token that names
  /// them.
  Map<String, String> threadMentions(String root) =>
      _threadMentions[root] ??
      reader.kept?.draft(reader.tabId, id, root)?.mentions ??
      const {};

  void setThreadDraft(
    String root,
    String text, [
    Map<String, String> mentions = const {},
  ]) {
    if (_refused) return;
    reader.kept?.setDraft(reader.tabId, id, root, text, mentions);
    if (text.isEmpty) {
      _threadDrafts.remove(root);
    } else {
      _threadDrafts[root] = text;
    }
    if (text.isEmpty || mentions.isEmpty) {
      _threadMentions.remove(root);
    } else {
      _threadMentions[root] = Map.of(mentions);
    }
  }

  /// On screen, no other screen covers it and Harness is in front: what it
  /// shows is read ([SwarmReader.readMarks]), now and as new messages come.
  bool get shown => _shown;
  bool _shown;
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
    // Back on screen: what the line last read may be long gone, so it is read
    // again before it is believed, under a new [_receiptReadFor].
    if (value) _dropReceipt();
    _markRead();
  }

  /// While the person reads back, the newest message they saw at the foot,
  /// or the one a notice opened the chat at: those after it are unseen and
  /// unread until they go down to them. Null at the foot.
  String? get heldAt => _heldAt;
  String? _heldAt;
  set heldAt(String? value) {
    if (_heldAt == value) return;
    _heldAt = value;
    _markRead();
  }

  /// Read through the newest message seen in the main stream, while it is
  /// [shown]: [heldAt] once it is read, else the last. A reply only in its
  /// thread is not on the chat's screen, so it never moves the mark (the
  /// desktop's `_loadedMessageSequence`): a mark cannot move back. A server
  /// too old to say a chat's newest main-stream message counts any, as the
  /// desktop does there.
  void _markRead() {
    if (!_shown) return;
    final held = _heldAt;
    final at = held == null
        ? messages.length - 1
        : messages.lastIndexWhere((m) => m.id == held);
    final group = conversation;
    final mainOnly = group == null || group.lastMainSequence != null;
    for (var i = at; i >= 0; i--) {
      if (mainOnly && !messages[i].inMainStream) continue;
      reader.readMarks?.markRead(id, messages[i].sequence);
      return;
    }
  }

  /// What the last read or post could not do, as a sentence.
  String? error;

  /// A post is on its way.
  bool get sending => _outbox.sending;

  /// Tells the composer what changed in it — the draft, the message it
  /// answers, a post leaving it — while this notifier itself tells the
  /// messages: a letter typed draws none of them again.
  Listenable get composer => _composer;
  final _composer = _Changes();

  SuperTabPage? _before;
  bool _read = false, _lost = false, _disposed = false;

  /// The backend refused the person this conversation: [SwarmChatState.lost]
  /// until a read of it succeeds.
  bool _refused = false;

  /// The Swarm's read has had it since it was last forgotten: one that then
  /// leaves the read hides its messages at once, where one never in it (a
  /// closed one, looked for by id) keeps those read meanwhile.
  late bool _listed;

  /// The messages are those kept from when the chat was last open, not yet
  /// read on from.
  bool _kept = false;

  /// A read told no one ([readBackTo]): told once it is done.
  bool _untold = false;
  Future<void>? _reading, _readingOlder, _locating, _rereading;

  /// The reaction counter ([SuperTabConversation.reactionSeq]) the page
  /// shown was read with: null until a read of that page said it.
  int? _reactionSeq;

  /// The person's reactions on their way, by message and emoji, each adding
  /// (true) or taking back: counted in [reactionsOf] until the backend has
  /// them.
  final _reacting = <(String, SuperTabReactionEmoji), bool>{};

  /// The messages a read found deleted since they were shown: a thread's
  /// own rows of them go too ([gone]).
  final _gone = <String>{};

  /// Message [id] was shown here and a read since found it deleted.
  bool gone(String id) => _gone.contains(id);

  /// Moves when what was read is dropped: a read asked for before then
  /// answers nothing.
  int _epoch = 0;
  String _draft = '';

  /// The person's posts on their way, each sent on its own and — while its
  /// answer never came — retried under its own operation id, so the backend
  /// runs it once.
  late final SwarmOutbox _outbox = SwarmOutbox(
    request: reader.request,
    path: '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
    timeout: sendTimeout,
    onChanged: () {
      _keepPosts();
      if (!_disposed) _tell();
    },
    onTaken: (post) {
      if (_disposed) return;
      _uploads.forget(post.files);
      if (error != null && error == _postError && _outbox.unconfirmed == null) {
        error = null;
      }
      unawaited(reader.refresh());
      // Shown as sent until the read that brings it back.
      unawaited(loadFromNow());
    },
    onRefused: (post) {
      if (_disposed) return;
      // A refusal of the files themselves sends them up once more; one of
      // the post (a mention, a recipient) leaves them uploaded.
      if (post.refusedBy?.code.contains('ATTACHMENT') ?? false) {
        _uploads.forget(post.files);
      }
      _restore(post);
      if (swarmRefusedForSessions(post)) {
        swarmSessionsRefused(reader);
        error = swarmSessionsUnavailable;
      } else {
        error = post.error;
      }
    },
  );

  /// The [error] a post's lost answer set: its later answer takes it back.
  String? _postError;

  SuperTabMessage? _replyingTo;

  /// Where its messages are read, a thread's with `?thread=`.
  String get messagesPath =>
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
      '/conversations/${Uri.encodeComponent(id)}/messages';

  SuperTabConversation? get conversation => reader.snapshot?.conversation(id);

  /// Earlier messages wait to be read.
  bool get hasOlder => _before != null;

  /// Where the chat stands: the page draws a skeleton, its messages, or
  /// "not open" from it.
  SwarmChatState get state => _refused
      ? SwarmChatState.lost
      : _read
      ? SwarmChatState.loaded
      : _locating != null
      ? SwarmChatState.locating
      : SwarmChatState.loading;

  /// A post was sent and not confirmed: [send] with nothing typed, or
  /// [retry], sends it again.
  bool get unconfirmed => _outbox.unconfirmed != null;

  /// The posts on their way, taken or not confirmed, oldest first: drawn at
  /// the foot of the chat, each "Sending…", as sent, or "Not sent · Retry",
  /// until a read brings it back.
  List<SwarmPost> get outgoing => _outbox.posts;

  /// The composer may post now: there is text or a file, and no upload is
  /// under way. A post on its way never holds the next one back.
  bool get canSend =>
      canPost &&
      !uploading &&
      (_draft.trim().isNotEmpty || files.files.isNotEmpty);

  @override
  bool isUploading(SwarmOutgoingFile file) => _uploads.isUploading(file);

  @override
  double? uploadProgress(SwarmOutgoingFile file) => _uploads.progress(file);

  /// The message the draft answers: the reply bar over the composer, and the
  /// post's `replyTo`.
  SuperTabMessage? get replyingTo => _replyingTo;
  set replyingTo(SuperTabMessage? message) {
    _replyingTo = message;
    _composer.changed();
  }

  /// New session is chosen for the next post (Desktop's chat composer), and
  /// the project it works in: none is All projects.
  bool _newSession = false;
  String? _sessionProjectId;

  /// Whether the composer shows New session: the person's own Buddy chat, on
  /// a server that takes it, where they may post. It may still show disabled,
  /// saying why ([sessionBlocked]).
  bool get offersSessions {
    final group = conversation;
    return group != null && canPost && swarmOffersChatSessions(reader, group);
  }

  /// Why New session cannot start a session now; null when it can.
  String? get sessionBlocked {
    final group = conversation;
    return group == null || !offersSessions
        ? null
        : swarmSessionBlocked(reader, group);
  }

  /// Whether the next post starts a session: chosen, offered and not blocked.
  bool get newSession =>
      _newSession && offersSessions && sessionBlocked == null;
  set newSession(bool value) {
    if (_newSession == value) return;
    _newSession = value;
    _composer.changed();
  }

  /// The project the next session works in, while the person still reads it
  /// (a lost one is no longer chosen); null is All projects: it reads every
  /// project and sends no work to a PM.
  String? get sessionProjectId =>
      reader.snapshot?.projects.any((p) => p.id == _sessionProjectId) == true
      ? _sessionProjectId
      : null;
  set sessionProjectId(String? value) {
    if (_sessionProjectId == value) return;
    _sessionProjectId = value;
    _composer.changed();
  }

  /// The threads whose session an end is under way for.
  final _ending = <String>{};

  /// Why the last End session was refused; null when it was not. The page
  /// that pressed it says it (the thread's).
  String? endRefusal;

  /// Whether an end is under way for [root]'s session.
  bool endingSession(String root) => _ending.contains(root);

  /// Ends [root]'s session in the person's own Buddy chat (Desktop's
  /// `endThreadSession`): closing the thread only hides it, this stops it.
  /// False when there is none, one end is already under way, or the backend
  /// refused (said in [error]).
  Future<bool> endSession(String root) async {
    final group = conversation;
    if (_disposed ||
        group == null ||
        !canPost ||
        group.sessionFor(root) == null ||
        !_ending.add(root)) {
      return false;
    }
    endRefusal = null;
    notifyListeners();
    String? refused;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'buddy.sessionEnd',
            'conversationId': id,
            'thread': root,
            'reason': 'ended',
          },
        },
      );
    } on SuperTabFailure catch (failure) {
      refused = failure.message;
    } catch (_) {
      refused = 'The session did not end. Try again.';
    }
    if (_disposed) return refused == null;
    _ending.remove(root);
    if (refused != null) {
      endRefusal = refused;
    } else {
      unawaited(reader.refresh());
      unawaited(_reread());
    }
    notifyListeners();
    return refused == null;
  }

  /// The person may post here: a writer of the Swarm, in a conversation that
  /// is not archived, nor an older Buddy chat kept to read.
  bool get canPost {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null ||
        group == null ||
        group.archived ||
        swarmIsOldBuddyChat(reader, id)) {
      return false;
    }
    return snapshot.people
            .where((p) => p.id == reader.accountId)
            .firstOrNull
            ?.canWrite ??
        false;
  }

  @override
  String get draft => _draft;
  @override
  set draft(String value) {
    _draft = value;
    keepMentionsOf(value);
    _composer.changed();
  }

  /// Whether [text] names [token] as a word of its own: the desktop's rule.
  static bool containsMention(String text, String token) =>
      RegExp('(?:^|\\s)${RegExp.escape(token)}(?=\$|\\s|[.,!?;:])')
          .hasMatch(text);

  /// The agents a post can mention: those in this conversation.
  List<SuperTabAgent> get mentionable {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null) return const [];
    return [for (final agentId in group.agentIds) ?snapshot.agent(agentId)];
  }

  /// The people a post can tag, as Desktop offers them: those who read this
  /// conversation, never the reader. In a Buddy chat only its owner reads it.
  /// The backend checks each tag again.
  List<SuperTabPerson> get mentionablePeople {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null) {
      return const [];
    }
    final project = snapshot.projectFor(group.id);
    bool reads(SuperTabPerson person) => switch (group) {
      SuperTabConversation(:final audience?) => audience.contains(person.id),
      _ when group.buddyOwnerId != null => person.id == group.buddyOwnerId,
      _ =>
        project == null ||
            !project.isPrivate ||
            project.ownerId == person.id ||
            project.hasMember(person),
    };
    return [
      for (final person in snapshot.people)
        if (person.id != reader.accountId && reads(person)) person,
    ];
  }

  /// The Swarm was read, changed or not.
  void _swarmChanged() {
    if (_disposed) return;
    if (reader.accessRevoked) {
      _lose();
      return;
    }
    if (reader.snapshot == null) return;
    final group = conversation;
    if (group == null) {
      if (_listed) {
        _listed = false;
        if (messages.isNotEmpty || _read) {
          _forget();
          notifyListeners();
        }
      }
      // Asked for by id until it is known unreadable; an ask that failed is
      // made again at the Swarm's next read.
      if (!_lost) unawaited(_locate());
      return;
    }
    _listed = true;
    if (_lost) _lost = _refused = false;
    // An open @ list follows who is in the Swarm and the chat now: someone
    // who left, or lost the chat, leaves it.
    if (mentionQuery != null) _composer.changed();
    final tail = messages.lastOrNull?.sequence ?? 0;
    if (!_read || group.lastMessageSequence > tail) {
      unawaited(load());
    } else if (_reactionSeq case final seq? when group.reactionSeq > seq) {
      // A reaction changed on a message already shown, here or on another
      // device.
      unawaited(_reread());
    }
    // An agent's prompt answered hides its warning with no new message
    // (prompt_alerts.dart): the page redraws for it.
    final answered = answeredPromptAlerts(
      messages,
      reader.snapshot!.agent,
    ).join(',');
    if (answered != _answeredAlerts) {
      _answeredAlerts = answered;
      notifyListeners();
    }
    _checkReceipt();
  }

  /// The prompt warnings the page last hid, as one key.
  String _answeredAlerts = '';

  /// Asks the reader for this conversation by id: a closed one comes back,
  /// and [_swarmChanged] reads it; one the person cannot read is lost.
  Future<void> _locate() => _locating ??= () async {
    try {
      if (!await reader.loadConversation(id) && !_disposed) {
        _lost = true;
        _lose();
      }
    } catch (_) {
      // Not known either way: asked again at the Swarm's next read.
    }
  }().whenComplete(() => _locating = null);

  /// Drops the messages read, and the answer of any read under way.
  void _forget() {
    messages = const [];
    _threads.clear();
    _before = null;
    _read = false;
    _epoch++;
    _reading = null;
    _readingOlder = null;
    _rereading = null;
    _reactionSeq = null;
    _gone.clear();
    _dropReceipt();
  }

  /// The person cannot read this conversation: nothing of it stays, here or
  /// kept for the next open.
  void _lose() {
    SwarmChatCache.drop(reader, id);
    final held =
        !_refused ||
        messages.isNotEmpty ||
        _read ||
        _draft.isNotEmpty ||
        !_outbox.isEmpty ||
        _replyingTo != null ||
        error != null;
    _refused = true;
    _forget();
    _draft = _keptDraft = '';
    _threadDrafts.clear();
    _threadMentions.clear();
    reader.kept?.dropChat(reader.tabId, id);
    // A thread's files go too; its own screen hears it and gives up theirs.
    for (final box in _threadFiles.values) {
      box.clear();
    }
    _threadFiles.clear();
    _mentions.clear();
    _outbox.clear();
    _replyingTo = null;
    _reacting.clear();
    _resolving = null;
    _resolveIds.clear();
    error = null;
    if (held) _tell();
  }

  /// The latest page the first time, then what came after the newest shown;
  /// a conversation the Swarm's read does not have is asked for by id at the
  /// same time. Joins a read under way.
  Future<void> load() {
    if (_disposed) return Future.value();
    final locating = reader.snapshot != null && conversation == null
        ? _locate()
        : null;
    var reading = _reading;
    if (reading == null) {
      late final Future<void> read;
      read = _load(older: false).whenComplete(() {
        if (identical(_reading, read)) _reading = null;
      });
      reading = _reading = read;
    }
    return locating == null ? reading : Future.wait([locating, reading]);
  }

  /// What came after the newest shown, read from now on: a read under way
  /// may have been asked before what calls this happened (a post taken), so
  /// a new one follows it.
  Future<void> loadFromNow() async {
    if (_reading case final reading?) await reading;
    return load();
  }

  /// The page before the oldest shown.
  Future<void> loadOlder() => _older(tell: true);

  /// Reads earlier pages until [messageId] is among the messages, the first
  /// one is reached or [pages] were read, and tells the chat once at the end
  /// rather than at each page: a quote followed to its original draws the
  /// chat once. True once the message is there.
  Future<bool> readBackTo(String messageId, {int pages = 50}) async {
    bool has() => messages.any((m) => m.id == messageId);
    var read = 0;
    try {
      while (!_disposed && !has() && hasOlder && read < pages) {
        await _older(tell: false);
        read++;
        if (error != null) break;
      }
    } finally {
      if (_untold && !_disposed) {
        _untold = false;
        notifyListeners();
      }
    }
    return has();
  }

  /// Reads the page shown again for its reaction counts; joins a read of it
  /// under way.
  Future<void> _reread() {
    if (_disposed) return Future.value();
    if (_rereading case final reading?) return reading;
    late final Future<void> reading;
    reading = _load(older: false, again: true).whenComplete(() {
      if (identical(_rereading, reading)) _rereading = null;
    });
    return _rereading = reading;
  }

  Future<void> _older({required bool tell}) {
    if (!hasOlder) return Future.value();
    if (_readingOlder case final reading?) return reading;
    late final Future<void> reading;
    reading = _load(older: true, tell: tell).whenComplete(() {
      if (identical(_readingOlder, reading)) _readingOlder = null;
    });
    return _readingOlder = reading;
  }

  /// One page: the one before the oldest shown, else what came after the
  /// newest — or, with [latest] or none shown, the latest page; with [again],
  /// the page that ends at the newest shown. Tells the chat what changed
  /// unless [tell] is false, which leaves it [_untold].
  Future<void> _load({
    required bool older,
    bool latest = false,
    bool again = false,
    bool tell = true,
  }) async {
    final epoch = _epoch, asked = ++_readsAsked;
    var reacted = false;
    try {
      final tail = latest ? null : messages.lastOrNull?.sequence;
      final before = _before;
      final query = older
          ? '?before=${before!.sequence}'
                '&beforeId=${Uri.encodeQueryComponent(before.id)}'
          : tail == null
          ? ''
          : again
          ? '?before=${tail + 1}'
          : '?after=$tail';
      final answer = superTabMap(
        await reader.request('GET', '$messagesPath$query'),
      );
      if (_disposed || epoch != _epoch) return;
      final incoming = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ];
      if (incoming.any((m) => m.conversationId != id)) {
        throw const FormatException('A different conversation was returned.');
      }
      if (!older && !again && _kept) {
        _kept = false;
        // More than a page came after what was kept: the latest page, as a
        // first open reads it, where reading on would leave a gap.
        if (tail != null && answer['next'] != null) {
          await _load(older: false, latest: true, tell: tell);
          return;
        }
      }
      // A message read again as it was stays the one shown, and a read that
      // brings nothing new tells no one: the chat draws nothing again.
      final byId = latest
          ? <String, SuperTabMessage>{}
          : {for (final m in messages) m.id: m};
      var changed = !_read || error != null || _refused || latest;
      changed |= _keepThreads(answer['threads']);
      for (final m in incoming) {
        if (m.id == _receiptOf) {
          // A read of it asked after this one holds where its delivery is now.
          final held = messages.where((m) => m.id == _receiptOf).firstOrNull;
          if (held != null && asked < _receiptAskedAs) {
            byId[m.id] = held;
            continue;
          }
          _receiptAskedAs = asked;
        }
        if (byId[m.id] case final shown? when _same(shown, m)) continue;
        byId[m.id] = m;
        changed = true;
      }
      // The page read again is the backend's word on every message it
      // covers: one shown there that it no longer has was deleted (backend
      // messageEdits.ts). Earlier pages it does not reach keep theirs.
      if (again && tail != null) {
        final covers = answer['next'] == null
            ? 0
            : incoming.isEmpty
            ? null
            : incoming.map((m) => m.sequence).reduce((a, b) => a < b ? a : b);
        if (covers != null) {
          final read = {for (final m in incoming) m.id};
          final gone = [
            for (final m in byId.values)
              if (m.sequence >= covers &&
                  m.sequence <= tail &&
                  !read.contains(m.id))
                m.id,
          ];
          for (final id in gone) {
            byId.remove(id);
          }
          if (gone.isNotEmpty) {
            _gone.addAll(gone);
            changed = true;
          }
        }
      }
      if (changed) {
        messages = List.unmodifiable(
          byId.values.toList()..sort(superTabMessageOrder),
        );
      }
      // A post read back shows as its message, once, whatever its answer.
      if (_outbox.settle(messages)) {
        changed = true;
        _keepPosts();
      }
      if (older || !_read || latest) {
        final before = SuperTabPage.read(answer['next']);
        changed |=
            before?.sequence != _before?.sequence || before?.id != _before?.id;
        _before = before;
      }
      // The counter the page shown was read with; a read of what came after
      // it that says a reaction changed since reads that page again.
      if ((answer['reactionSeq'] as num?)?.toInt() case final seq?
          when !older) {
        if (again || tail == null) {
          _reactionSeq = seq;
        } else {
          reacted = seq > (_reactionSeq ?? -1);
        }
      }
      _read = true;
      _refused = false;
      error = null;
      if (!older) _markRead();
      if (!changed) {
        if (reacted) await _reread();
        return;
      }
    } on SuperTabFailure catch (failure) {
      if (_disposed || epoch != _epoch) return;
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) _lose();
      error = failure.message;
    } catch (_) {
      if (_disposed || epoch != _epoch) return;
      error = 'Could not load messages. Try again.';
    }
    if (tell) {
      notifyListeners();
    } else {
      _untold = true;
    }
    if (reacted) await _reread();
  }

  /// Posts the draft and its [files], to the agents mentioned in it and as a
  /// reply to [replyingTo] — or, with nothing typed while a post is
  /// [unconfirmed], sends that one again. The files go up first, one by one,
  /// the draft and the files staying in the composer meanwhile; then the post
  /// leaves the draft at once, with the files, and shows in [outgoing] until
  /// it is read back. A post on its way never holds this one back. True once
  /// the backend took it.
  Future<bool> send() async {
    if (uploading || _disposed || !canPost) return false;
    final outgoing = files.files;
    if (_draft.trim().isEmpty && outgoing.isEmpty) {
      final again = _outbox.unconfirmed;
      return again != null && await retry(again);
    }
    final group = conversation;
    if (group == null) return false;
    // As the desktop's, before any file goes up.
    if (namesAgentGone(_draft, group.agentIds)) {
      error = swarmMentionedAgentLeft;
      _tell();
      return false;
    }
    final ids = await _uploadAll(outgoing);
    if (ids == null || _disposed) return false;
    final body = _compose(ids);
    if (body == null) return false;
    final startsSession = newSession;
    final root = _replyingTo?.thread ?? _replyingTo?.id;
    final post = SwarmPost(
      body: body,
      messageId: superTabMessageId(
        tabId: reader.tabId,
        accountId: reader.accountId,
        operationId: body['operationId'] as String,
      ),
      files: outgoing,
      held: (
        draft: _draft,
        mentions: Map.of(_mentions),
        replyTo: _replyingTo,
        newSession: _newSession,
        sessionProjectId: _sessionProjectId,
      ),
    );
    _draft = '';
    _mentions.clear();
    _keepDraft();
    _replyingTo = null;
    _newSession = false;
    _sessionProjectId = null;
    // Only what goes with this post: more may have been added meanwhile.
    for (final file in outgoing) {
      files.remove(file);
    }
    error = null;
    final taken = _answered(post, await _outbox.add(post));
    // Its thread opens beside the chat: the session answers there. A
    // top-level message is its own thread's root.
    if (taken && startsSession) _startedRoot = root ?? post.messageId;
    return taken;
  }

  String? _startedRoot;

  /// Sends [take] as a voice message, alone, as a reply to [replyingTo] when
  /// there is one: its clip goes up, the backend reads it once in [lang], and
  /// the post names that file. What is typed stays in the box. Not sent, the
  /// take is the voice row's to keep; a post whose answer was lost is the
  /// outbox's, sent again from where it shows like any other.
  Future<SwarmVoicePosted> sendVoice(VoiceTake take, String lang) async {
    final group = conversation;
    if (uploading || _disposed || !canPost || group == null) {
      return (sent: false, notice: null);
    }
    final clip = SwarmOutgoingFile(swarmVoiceFileName, take.wav);
    // A failure says itself in the chat, as a file's does.
    final ids = await _uploadAll([clip]);
    if (ids == null || _disposed) return (sent: false, notice: null);
    final read = await swarmReadVoice(
      reader.request,
      tabId: reader.tabId,
      attachmentId: ids.single,
      lang: lang,
    );
    final voice = read.voice;
    if (_disposed || voice == null) return (sent: false, notice: read.refused);
    final operationId = superTabOperationId();
    final post = SwarmPost(
      body: {
        'operationId': operationId,
        'command': {
          'type': 'message.send',
          'conversationId': id,
          'text': '',
          'replyTo': _replyingTo?.id,
          'recipientIds': const <String>[],
          'attachmentIds': ids,
          if (reader.snapshot?.swarmBuddy == true) 'oneBuddy': true,
        },
      },
      messageId: superTabMessageId(
        tabId: reader.tabId,
        accountId: reader.accountId,
        operationId: operationId,
      ),
      files: [clip],
      voice: voice,
    );
    _replyingTo = null;
    error = null;
    final outcome = await _outbox.add(post);
    _answered(post, outcome);
    final sent =
        outcome == SwarmPostOutcome.taken || outcome == SwarmPostOutcome.lost;
    // It says nothing once sent: a voice message plays only, and never
    // has words to go without (anh Dee, 2026-11-04).
    return (sent: sent, notice: null);
  }

  /// The thread whose session the last post started, once the backend took
  /// it; read once.
  String? takeStartedSession() {
    final root = _startedRoot;
    _startedRoot = null;
    return root;
  }

  /// Sends [post], not confirmed, again under its own operation id: the
  /// backend posts it once however often it goes.
  Future<bool> retry(SwarmPost post) async {
    if (_disposed ||
        !canPost ||
        post.state != SwarmPostState.unconfirmed ||
        !_outbox.posts.contains(post)) {
      return false;
    }
    error = null;
    return _answered(post, await _outbox.deliver(post));
  }

  /// What [post]'s try came to, said: a refusal puts its text back in the
  /// draft, a lost answer says Not sent.
  bool _answered(SwarmPost post, SwarmPostOutcome outcome) {
    if (_disposed) return outcome == SwarmPostOutcome.taken;
    switch (outcome) {
      case SwarmPostOutcome.taken:
        return true;
      case SwarmPostOutcome.gone:
      // Put back and said by [SwarmOutbox.onRefused].
      case SwarmPostOutcome.refused:
        return false;
      case SwarmPostOutcome.lost:
        error = _postError = post.error;
    }
    _tell();
    return false;
  }

  /// Uploads each of [outgoing] that has not gone up yet and returns their
  /// ids, or null with [error] set when one could not. The draft and the
  /// files stay where they are.
  Future<List<String>?> _uploadAll(List<SwarmOutgoingFile> outgoing) async {
    if (outgoing.isEmpty) return const [];
    error = null;
    final up = await _uploads.upload(outgoing);
    if (up.failure case final failure? when !_disposed) {
      error = swarmUploadError(failure, outgoing.length);
      _tell();
    }
    return up.ids;
  }

  /// Gives up the files on their way: the composer is free again, and the
  /// draft and the files stay.
  void cancelUpload() => _uploads.cancel();

  /// Taking a file off while the files go up gives the upload up.
  void _filesChanged() {
    _uploads.keepTo(files.files);
    _composer.changed();
  }

  /// [message]'s counts as the person sees them: their own reaction on its
  /// way already counted, or already taken back.
  List<SuperTabReactionCount> reactionsOf(SuperTabMessage message) {
    var counts = message.reactions;
    for (final MapEntry(key: (messageId, emoji), value: on)
        in _reacting.entries) {
      if (messageId == message.id) counts = _toggled(counts, emoji, on);
    }
    return counts;
  }

  /// [counts] with the person's [emoji] added ([on]) or taken back.
  List<SuperTabReactionCount> _toggled(
    List<SuperTabReactionCount> counts,
    SuperTabReactionEmoji emoji,
    bool on,
  ) {
    final me = (kind: 'person', id: reader.accountId);
    final was = counts.where((r) => r.emoji == emoji).firstOrNull?.by;
    final by = [...?was?.where((who) => who != me), if (on) me];
    return List.unmodifiable(
      [
        for (final r in counts)
          if (r.emoji != emoji) r,
        if (by.isNotEmpty) SuperTabReactionCount(emoji, by),
      ]..sort((a, b) => a.emoji.index.compareTo(b.emoji.index)),
    );
  }

  /// Adds the person's [emoji] to [message], or takes it back when it is
  /// already theirs (the desktop's `react`): counted at once, sent, then the
  /// page shown is read again so the counts are the backend's. A refusal
  /// takes it back and says why in [error]. True once the backend took it.
  Future<bool> react(
    SuperTabMessage message,
    SuperTabReactionEmoji emoji,
  ) async {
    final key = (message.id, emoji);
    if (_disposed || !canPost || _reacting.containsKey(key)) return false;
    final on = !reactionsOf(message)
        .any((r) => r.emoji == emoji && r.includes('person', reader.accountId));
    _reacting[key] = on;
    error = null;
    notifyListeners();
    String? refused;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'message.react',
            'conversationId': id,
            'messageId': message.id,
            'emoji': emoji.key,
            'on': on,
            // As the desktop's: the server refuses it in an older Buddy chat.
            if (reader.snapshot?.swarmBuddy == true) 'oneBuddy': true,
          },
        },
      );
    } on SuperTabFailure catch (failure) {
      refused = failure.message;
    } catch (_) {
      refused = 'Your reaction did not go through. Try again.';
    }
    if (refused == null && !_disposed) {
      // A read of the page begun before the backend had it would not show
      // it: the read that counts it starts after.
      if (_rereading case final reading?) await reading;
      await _reread();
    }
    if (_disposed) return refused == null;
    _reacting.remove(key);
    if (refused != null) error = refused;
    notifyListeners();
    return refused == null;
  }

  /// The person may edit and delete [message]: their own plain post (no
  /// note the server wrote in their name), not deleted, where they may post.
  /// The backend decides again (messageEdits.ts); this only hides the menu.
  bool mayChange(SuperTabMessage message) =>
      canPost &&
      message.author['kind'] == 'person' &&
      message.authorId == reader.accountId &&
      message.source.isEmpty &&
      !message.deleted;

  /// Puts [text], trimmed, in place of [message]'s (backend `message.edit`):
  /// the chat shows it, "(edited)", once the backend has it. Answers why it
  /// was refused, the old text staying; null once done, or when nothing
  /// changed and nothing was sent.
  Future<String?> editMessage(SuperTabMessage message, String text) async {
    final trimmed = text.trim();
    if (trimmed == message.text) return null;
    if (trimmed.isEmpty && message.attachments.isEmpty) {
      return 'Write something, or delete the message.';
    }
    return _change(message, {
      'type': 'message.edit',
      'conversationId': id,
      'messageId': message.id,
      'text': trimmed,
    }, 'Your edit did not go through. Try again.');
  }

  /// Deletes [message] for everyone (backend `message.delete`): it leaves the
  /// chat, or, as the root of a thread with replies, reads "This message was
  /// deleted." over them. Answers why it was refused; null once done.
  Future<String?> deleteMessage(SuperTabMessage message) => _change(message, {
    'type': 'message.delete',
    'conversationId': id,
    'messageId': message.id,
  }, 'The message was not deleted. Try again.');

  /// Sends the person's change to [message], then reads the page shown again
  /// so it shows at once; one before that page is read by itself.
  Future<String?> _change(
    SuperTabMessage message,
    Map<String, dynamic> command,
    String failed,
  ) async {
    if (_disposed || !mayChange(message)) return failed;
    final epoch = _epoch;
    SuperTabMessage? shown() =>
        messages.where((m) => m.id == message.id).firstOrNull;
    final before = shown();
    Object? answer;
    try {
      answer = await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {'operationId': superTabOperationId(), 'command': command},
      );
    } on SuperTabFailure catch (failure) {
      return failure.message;
    } catch (_) {
      return failed;
    }
    if (_disposed || epoch != _epoch) return null;
    // Deleted with no replies to keep it: gone at once, before any read.
    final result = answer is Map ? answer['result'] : null;
    if (command['type'] == 'message.delete' &&
        result is Map &&
        result['kept'] == false) {
      _drop(message.id);
    }
    unawaited(reader.refresh());
    // A read of the page begun before the backend had it would not show it.
    if (_rereading case final reading?) await reading;
    await _reread();
    if (_disposed || epoch != _epoch) return null;
    // Not on the page read again (one read back, or a thread's): by itself.
    if (shown() case final now? when identical(now, before)) {
      await _readBack(message.id);
    }
    return null;
  }

  /// Takes message [id] out of the chat: deleted.
  void _drop(String id) {
    if (!messages.any((m) => m.id == id)) return;
    messages = List.unmodifiable(messages.where((m) => m.id != id));
    _gone.add(id);
    notifyListeners();
  }

  /// Reads message [id] by itself, after the person changed it where the
  /// page read again does not reach: its row as the backend has it now, or
  /// gone. A failed read keeps the row shown until the next read of it.
  Future<void> _readBack(String messageId) async {
    final epoch = _epoch;
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '$messagesPath?messageId=${Uri.encodeQueryComponent(messageId)}',
        ),
      );
      if (_disposed || epoch != _epoch) return;
      final fresh = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ].where((m) => m.id == messageId && m.conversationId == id).firstOrNull;
      final at = messages.indexWhere((m) => m.id == messageId);
      if (at < 0) return;
      if (fresh == null) {
        _drop(messageId);
      } else if (!_same(messages[at], fresh)) {
        messages = List.unmodifiable([...messages]..[at] = fresh);
        notifyListeners();
      }
    } catch (_) {
      // Shown as it was; the next read of its page brings it.
    }
  }

  /// The delivery a person's answer is on its way for, and the answer
  /// ([resolveDelivery]).
  (String, String)? get resolving => _resolving;
  (String, String)? _resolving;

  /// The receipt of an answer whose reply never came, by delivery and
  /// answer: the same answer again goes under it, so the backend runs it once
  /// and a message is never sent twice for one tap.
  final _resolveIds = <(String, String), String>{};

  /// Settles [message]'s unconfirmed [delivery] as the person checked it
  /// (the desktop's `_resolveDelivery`): `resend` sends it again, `received`
  /// says it arrived. Then the message and what the backend wrote are read
  /// again; a refusal says why in [error]. True once the backend took it.
  Future<bool> resolveDelivery(
    SuperTabMessage message,
    SuperTabDelivery delivery,
    String resolution,
  ) async {
    final deliveryId = delivery.id;
    if (_disposed ||
        !canPost ||
        _resolving != null ||
        deliveryId == null ||
        delivery.status != 'uncertain' ||
        !receiptCurrent(message)) {
      return false;
    }
    final key = (deliveryId, resolution);
    final operationId = _resolveIds.putIfAbsent(key, superTabOperationId);
    final epoch = _epoch, generation = reader.generation;
    bool stale() =>
        _disposed || epoch != _epoch || generation != reader.generation;
    _resolving = key;
    error = null;
    notifyListeners();
    String? refused;
    var settled = true;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {
          'operationId': operationId,
          'command': {
            'type': 'delivery.resolve',
            'deliveryId': deliveryId,
            'resolution': resolution,
          },
        },
      );
    } on SuperTabFailure catch (failure) {
      refused = failure.message;
      // A refusal did nothing; a reply lost on the way may have: the same
      // answer again goes under the same receipt.
      settled =
          failure.statusCode >= 400 &&
          failure.statusCode < 500 &&
          !const {408, 429}.contains(failure.statusCode);
    } catch (_) {
      refused = 'The action is not confirmed. Retry to check it.';
      settled = false;
    }
    // Lost access, signed out or the chat forgotten meanwhile: the answer is
    // for a chat no longer shown, and says nothing in it.
    if (_disposed) return false;
    if (stale()) {
      if (_resolving == key) {
        _resolving = null;
        notifyListeners();
      }
      return false;
    }
    if (settled) _resolveIds.remove(key);
    _resolving = null;
    error = refused;
    notifyListeners();
    // Sent again, arrived, or settled before the answer (delivered, or
    // refused as no longer needing it): the line follows what is read now.
    if (settled) {
      for (var held = _readingReceipt; held != null; held = _readingReceipt) {
        await held;
      }
      if (stale() || _receiptOf != message.id) return refused == null;
      _receiptAsked = clock.now();
      final reading = _readReceipt(message.id);
      _readingReceipt = reading;
      await Future.wait([
        reading.whenComplete(() {
          if (identical(_readingReceipt, reading)) _readingReceipt = null;
        }),
        if (refused == null) load(),
      ]);
    }
    return refused == null;
  }

  /// Keeps the thread lines a page named ([thread]): one a later page said
  /// is kept over an older one. True when a line drawn changed.
  bool _keepThreads(Object? rows) {
    if (rows is! List) return false;
    var changed = false;
    for (final row in rows) {
      final next = SuperTabThread.fromJson(superTabMap(row));
      final held = _threads[next.id];
      if (held != null &&
          (held.lastSequence > next.lastSequence || _sameThread(held, next))) {
        continue;
      }
      _threads[next.id] = next;
      changed = true;
    }
    return changed;
  }

  /// Thread lines a thread's own read brought ([SwarmThread]): the root's
  /// line in the chat moves with them.
  void keepThreads(Object? rows) {
    if (!_disposed && _keepThreads(rows)) notifyListeners();
  }

  /// What a thread's line draws, the same in [a] as in [b].
  static bool _sameThread(SuperTabThread a, SuperTabThread b) =>
      a.replies == b.replies &&
      a.ask == b.ask &&
      a.lastSequence == b.lastSequence &&
      a.lastAt == b.lastAt &&
      listEquals(
        [for (final who in a.authors) '${who['kind']}:${who['id']}'],
        [for (final who in b.authors) '${who['kind']}:${who['id']}'],
      );

  /// A post moved between the composer and the messages: both are told.
  void _tell() {
    notifyListeners();
    _composer.changed();
  }

  /// What a row draws of a message, the same in [a] as in [b].
  static bool _same(SuperTabMessage a, SuperTabMessage b) =>
      a.sequence == b.sequence &&
      a.text == b.text &&
      a.replyTo == b.replyTo &&
      a.authorName == b.authorName &&
      a.createdAt == b.createdAt &&
      a.editedAt == b.editedAt &&
      a.deletedAt == b.deletedAt &&
      a.attachments.length == b.attachments.length &&
      _sameReactions(a.reactions, b.reactions) &&
      _sameDeliveries(a, b);

  /// What the delivery line draws from: each failed claim's count changes
  /// nothing there, so it draws nothing again.
  static bool _sameDeliveries(SuperTabMessage a, SuperTabMessage b) {
    if (a.deliveries.length != b.deliveries.length) return false;
    for (var i = 0; i < a.deliveries.length; i++) {
      for (final field in const [
        'id',
        'agentId',
        'status',
        'claimFailingSince',
      ]) {
        if (a.deliveries[i][field] != b.deliveries[i][field]) return false;
      }
    }
    return true;
  }

  static bool _sameReactions(
    List<SuperTabReactionCount> a,
    List<SuperTabReactionCount> b,
  ) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].emoji != b[i].emoji || !listEquals(a[i].by, b[i].by)) {
        return false;
      }
    }
    return true;
  }

  /// How often the person's newest message is read again while its delivery
  /// is queued, and for how long once it is on screen (Lead, 10-30): a phone
  /// pays for every read, and the chat's own reads see no delivery change.
  static const _receiptReadEvery = Duration(seconds: 30);
  static const _receiptReadFor = Duration(minutes: 10);

  /// How long a claimed or unconfirmed delivery is read again: as long as the
  /// backend lets it stand — a busy terminal holds a claim up to an hour, and
  /// a person has an hour to check an unconfirmed one (`deliverySettle.ts`
  /// `HOLD_LIMIT_MS`, `UNCERTAIN_LIMIT_MS`). Still only while on screen.
  static const _heldReadFor = Duration(minutes: 60);

  String? _receiptOf;
  DateTime? _receiptSince, _receiptAsked;

  /// The newest message when it was last asked: one that came after it may
  /// have answered it, so it is read once more, even past [_receiptReadFor].
  int? _receiptTail;

  /// Reads are numbered as they are asked; [_receiptAskedAs] is the one the
  /// row held came from, so an older answer landing later cannot put it back.
  int _readsAsked = 0, _receiptAskedAs = -1;
  bool _receiptCurrent = false;
  Future<void>? _readingReceipt;

  /// The person's newest message here, written by them and not by an agent, a
  /// terminal or the server in their name: the only one that can carry a
  /// delivery line (Desktop's `isOwn`).
  SuperTabMessage? get latestOwn {
    for (final m in messages.reversed) {
      if (!m.fromAgent &&
          !m.fromTerminal &&
          !m.postedForAuthor &&
          m.authorId == reader.accountId) {
        return m;
      }
    }
    return null;
  }

  /// [message]'s deliveries were last read here, and that read worked: a row
  /// kept from an earlier open, or a read that failed, proves nothing about
  /// where the delivery is now.
  bool receiptCurrent(SuperTabMessage message) =>
      _receiptCurrent && _receiptOf == message.id;

  void _dropReceipt() {
    _receiptOf = _receiptSince = _receiptAsked = _receiptTail = null;
    _receiptAskedAs = -1;
    _receiptCurrent = false;
    _readingReceipt = null;
  }

  /// The deliveries the newest own message is read again for: queued, taken
  /// by its computer (it may come back unconfirmed), or unconfirmed until a
  /// person settles it ([resolveDelivery]) or it arrives.
  static const _openDeliveries = {'queued', 'claimed', 'uncertain'};

  /// Reads the person's newest message again, at the Swarm's own reads, while
  /// it is on screen and its delivery is open. No timer of its own: off
  /// screen nothing asks.
  void _checkReceipt() {
    if (!_shown || _readingReceipt != null || reader.error != null) return;
    final own = latestOwn;
    final status = own?.receiptDelivery?.status;
    if (own == null || !_openDeliveries.contains(status)) return;
    final readFor = status == 'queued' ? _receiptReadFor : _heldReadFor;
    final now = clock.now();
    if (_receiptOf != own.id) {
      _dropReceipt();
      _receiptOf = own.id;
      _receiptSince = now;
    }
    final asked = _receiptAsked;
    if (asked != null && now.difference(asked) < _receiptReadEvery) return;
    final tail = messages.last.sequence;
    final answered = tail > own.sequence && tail != _receiptTail;
    if (!answered && now.difference(_receiptSince!) >= readFor) return;
    _receiptAsked = now;
    _receiptTail = tail;
    late final Future<void> reading;
    reading = _readReceipt(own.id).whenComplete(() {
      if (identical(_readingReceipt, reading)) _readingReceipt = null;
    });
    _readingReceipt = reading;
  }

  Future<void> _readReceipt(String messageId) async {
    final epoch = _epoch, generation = reader.generation, asked = ++_readsAsked;
    bool stale() =>
        _disposed ||
        epoch != _epoch ||
        generation != reader.generation ||
        _receiptOf != messageId;
    SuperTabMessage? read;
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '$messagesPath?messageId=${Uri.encodeQueryComponent(messageId)}',
        ),
      );
      if (stale()) return;
      read = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ].where((m) => m.id == messageId && m.conversationId == id).firstOrNull;
    } on SuperTabFailure catch (failure) {
      if (stale()) return;
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        _lose();
        error = failure.message;
        notifyListeners();
        return;
      }
    } catch (_) {
      if (stale()) return;
    }
    final fresh = read;
    final at = fresh == null
        ? -1
        : messages.indexWhere((m) => m.id == fresh.id);
    final current = at >= 0;
    // The chat's own read may have been asked after this one and landed first.
    final newest = current && asked >= _receiptAskedAs;
    if (newest) _receiptAskedAs = asked;
    final replaced = newest && !_same(messages[at], fresh!);
    if (replaced) {
      messages = List.unmodifiable([...messages]..[at] = fresh);
    }
    if (replaced || current != _receiptCurrent) {
      _receiptCurrent = current;
      notifyListeners();
    }
  }

  /// A refused post's text back in the draft, before anything typed since.
  void _restore(SwarmPost post) {
    final sent = post.held;
    if (sent
        is! ({
          String draft,
          Map<String, String> mentions,
          SuperTabMessage? replyTo,
          bool newSession,
          String? sessionProjectId,
        })) {
      return;
    }
    _draft = _draft.trim().isEmpty ? sent.draft : '${sent.draft}\n$_draft';
    _mentions.addAll(sent.mentions);
    _replyingTo ??= sent.replyTo;
    // Refused for New session itself, it comes back without it, ready to send
    // as a plain message; refused for anything else, the choice stays.
    if (!swarmRefusedForSessions(post)) {
      _newSession = _newSession || sent.newSession;
      _sessionProjectId ??= sent.sessionProjectId;
    }
    if (post.files.isNotEmpty) {
      final since = files.files;
      files
        ..clear()
        ..add([...post.files, ...since]);
    }
  }

  Map<String, dynamic>? _compose([List<String> attachmentIds = const []]) {
    final text = _draft.trim();
    final group = conversation;
    if ((text.isEmpty && attachmentIds.isEmpty) || group == null) return null;
    final (:tagged, :addressed) = mentionsSaid(text, group.agentIds);
    return {
      'operationId': superTabOperationId(),
      'command': {
        'type': 'message.send',
        'conversationId': id,
        'text': text,
        'replyTo': _replyingTo?.id,
        'recipientIds': addressed,
        if (tagged.isNotEmpty) 'mentions': tagged,
        if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
        // As the desktop's: the server refuses it in an older Buddy chat.
        if (reader.snapshot?.swarmBuddy == true) 'oneBuddy': true,
        if (newSession) 'newSession': true,
        // A New session in one project of the person's one Buddy chat.
        if (newSession && sessionProjectId != null && group.isSwarmBuddyChat)
          'sessionProjectId': sessionProjectId,
      },
    };
  }

  @override
  void dispose() {
    _keepDraft();
    reader.kept?.removeListener(_takeKeptOnce);
    _disposed = true;
    _uploads.close();
    _outbox.close();
    for (final box in _threadFiles.values) {
      box.clear();
    }
    _threadFiles.clear();
    files
      ..removeListener(_filesChanged)
      ..clear()
      ..dispose();
    // Shown at once when opened again, while the person can still read it.
    if (_read && !_refused) {
      SwarmChatCache.keep(
        reader,
        id,
        messages: messages,
        before: _before,
        reactionSeq: _reactionSeq,
        threads: _threads,
      );
    }
    reader.removeListener(_swarmChanged);
    reader.reads.removeListener(_swarmChanged);
    _composer.dispose();
    super.dispose();
  }
}

/// Where a chat stands: its first page on its way, looked for by id (one no
/// full read of its Swarm has), read, or not open to the person — said only
/// once the backend refused it.
enum SwarmChatState { loading, locating, loaded, lost }

/// A notifier told from outside it: the conversation's [composer].
class _Changes extends ChangeNotifier {
  void changed() => notifyListeners();
}

/// The desktop's words (`controller.dart` `send`, `sendThreadReply`) for a
/// draft that still names an agent picked for it who has left the chat since.
const swarmMentionedAgentLeft =
    'A mentioned agent is no longer in this conversation. '
    'Remove its mention or choose another agent.';

/// The @ of a box — the chat's composer, a thread's reply box
/// ([SwarmThread]): the name typed after an @, and the agents and people
/// picked for the draft while its text still names them.
mixin SwarmMentioning {
  SwarmReader get reader;
  String get draft;

  /// Calls [keepMentionsOf] and tells the box.
  set draft(String value);

  /// Agents and people mentioned in the draft, by id, with the token that
  /// names them: an agent's is a recipient, a person's a tag.
  final _mentions = <String, String>{};

  /// Those the draft mentions, by id with the token that names them.
  Map<String, String> get mentions => Map.unmodifiable(_mentions);

  /// [picked] mentioned again: a draft kept, or a post refused, put back.
  @protected
  void restoreMentions(Map<String, String> picked) => _mentions.addAll(picked);

  /// Nobody is mentioned any more: the draft went, or the box with it.
  @protected
  void forgetMentions() => _mentions.clear();

  /// Drops those [text] no longer names.
  @protected
  void keepMentionsOf(String text) => _mentions.removeWhere(
    (_, token) => !SwarmConversation.containsMention(text, token),
  );

  /// The name typed after an @ that ends the draft — what the mention picker
  /// narrows to; null while the draft does not end in one.
  String? get mentionQuery =>
      RegExp(r'(?:^|\s)@(\S*)$').firstMatch(draft)?.group(1);

  /// [id]'s name — an agent's or a person's — in place of the @ being typed
  /// ([mentionQuery]), as [mention] adds it.
  void completeMention(String id) {
    final text = draft;
    final query = mentionQuery;
    _name(
      id,
      query == null ? text : text.substring(0, text.length - query.length - 1),
    );
  }

  /// The Tag chip: ends the draft in an @, which opens the picker, or takes
  /// back an @ with no name typed after it. A name being typed is left alone.
  void toggleMention() {
    final text = draft;
    switch (mentionQuery) {
      case null:
        final spaced = text.isEmpty || RegExp(r'\s$').hasMatch(text);
        draft = '$text${spaced ? '' : ' '}@';
      case '':
        draft = text.substring(0, text.length - 1);
      case _:
        break;
    }
  }

  /// Adds [id]'s name to the draft: an agent's (the post goes to it) or a
  /// person's username (the post tags them), while the name stays in the
  /// text.
  void mention(String id) => _name(id, draft);

  /// The token that names [id] in a draft: a person's username or an
  /// agent's name, after an @. Null before the Swarm is read.
  String? _tokenOf(String id) {
    final snapshot = reader.snapshot;
    if (snapshot == null) return null;
    final person = snapshot.people.where((p) => p.id == id).firstOrNull;
    return '@${person?.username ?? snapshot.agentName(id)}';
  }

  /// Those a sent [command] named, by id with their tokens as [text] still
  /// says them: what a kept post puts back in the box when it is refused.
  Map<String, String> mentionsSent(Map<String, dynamic> command, String text) {
    final ids = {
      ...?(command['recipientIds'] as List?)?.whereType<String>(),
      ...?(command['mentions'] as List?)?.whereType<String>(),
    };
    return {
      for (final id in ids)
        if (_tokenOf(id) case final token?
            when SwarmConversation.containsMention(text, token))
          id: token,
    };
  }

  /// [id]'s name after [before], as the draft.
  void _name(String id, String before) {
    final token = _tokenOf(id);
    if (token == null) return;
    final spaced = before.isEmpty || RegExp(r'\s$').hasMatch(before);
    // Picked first: the draft keeps only those its text names.
    _mentions[id] = token;
    draft = '$before${spaced ? '' : ' '}$token ';
  }

  /// What the mentions [text] still names send, as Desktop sends them
  /// (`_tagsSaid`): the people still in the Swarm, tagged, and the agents of
  /// [agentIds], its recipients. The backend checks each again, and refuses
  /// a person who cannot read the chat.
  /// Whether [text] still names an agent picked for it that is not one of
  /// [agentIds] any more: an agent of the Swarm that has left the chat
  /// since, which the desktop refuses (`send`, `sendThreadReply`). A person
  /// who left the Swarm is only no longer tagged, as before.
  bool namesAgentGone(String text, List<String> agentIds) {
    final snapshot = reader.snapshot;
    if (snapshot == null) return false;
    return _mentions.entries.any(
      (entry) =>
          SwarmConversation.containsMention(text, entry.value) &&
          !agentIds.contains(entry.key) &&
          snapshot.agent(entry.key) != null &&
          !snapshot.people.any((p) => p.id == entry.key),
    );
  }

  ({List<String> tagged, List<String> addressed}) mentionsSaid(
    String text,
    List<String> agentIds,
  ) {
    final people = {...?reader.snapshot?.people.map((p) => p.id)};
    final said = [
      for (final MapEntry(key: id, value: token) in _mentions.entries)
        if (SwarmConversation.containsMention(text, token)) id,
    ];
    return (
      tagged: [
        for (final id in said)
          if (people.contains(id)) id,
      ],
      addressed: [
        for (final id in said)
          if (agentIds.contains(id)) id,
      ],
    );
  }
}
