import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'prompt_alerts.dart';
import 'swarm_chat_cache.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_uploads.dart';

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
class SwarmConversation extends ChangeNotifier implements SwarmFilesBox {
  /// [shown] and [heldAt] as they are from the start, so what it kept is
  /// read only as far as it is seen.
  SwarmConversation(
    this.reader,
    this.id, {
    this.uploadTimeout = const Duration(minutes: 2),
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
  }

  final SwarmReader reader;
  final String id;

  /// How long an upload may go without a byte moving before the send gives up.
  final Duration uploadTimeout;

  /// The files waiting to go with the next post. They stay in memory, and go
  /// when the chat closes: only what the person typed is kept, and only while
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
  /// alone ([SuperTabMessage.inMainStream], the desktop's main stream).
  List<SuperTabMessage> get stream {
    if (!identical(_streamOf, messages)) {
      _streamOf = messages;
      _stream = List.unmodifiable(messages.where((m) => m.inMainStream));
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
  /// `threadDraft`): a thread closed and opened again finds it.
  final _threadDrafts = <String, String>{};

  String threadDraft(String root) => _threadDrafts[root] ?? '';
  void setThreadDraft(String root, String text) {
    if (text.isEmpty) {
      _threadDrafts.remove(root);
    } else {
      _threadDrafts[root] = text;
    }
  }

  /// On screen, no other screen covers it and Harness is in front: what it
  /// shows is read ([SwarmReader.readMarks]), now and as new messages come.
  bool get shown => _shown;
  bool _shown;
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
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

  /// Read through the newest message seen, while it is [shown]: [heldAt]
  /// once it is read, else the last.
  void _markRead() {
    if (!_shown) return;
    final held = _heldAt;
    final at = held == null ? -1 : messages.lastIndexWhere((m) => m.id == held);
    final seen = held == null
        ? messages.lastOrNull
        : at < 0
        ? null
        : messages[at];
    if (seen != null) reader.readMarks?.markRead(id, seen.sequence);
  }

  /// What the last read or post could not do, as a sentence.
  String? error;

  /// A post is on its way.
  bool sending = false;

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

  /// Moves when what was read is dropped: a read asked for before then
  /// answers nothing.
  int _epoch = 0;
  String _draft = '';

  /// Agents and people mentioned in the draft, by id, with the token that
  /// names them: an agent's is a recipient, a person's a tag.
  final _mentions = <String, String>{};

  /// The post on its way, then — while its answer never came — retried under
  /// the same operation id, so the backend runs it once.
  Map<String, dynamic>? _pending;

  /// What the draft was when [_pending] left it: a refusal puts it back.
  ({
    String draft,
    Map<String, String> mentions,
    SuperTabMessage? replyTo,
    List<SwarmOutgoingFile> files,
  })?
  _sent;

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

  /// A post was sent and not confirmed: [send] retries it.
  bool get unconfirmed => _pending != null && !sending;

  /// The post on its way or not confirmed, out of the draft: drawn at the
  /// foot of the chat, "Sending…" and then [unconfirmed], until it is read
  /// back.
  ({String text, String? replyTo, List<SwarmOutgoingFile> files})? get pending {
    final command = _pending?['command'] as Map?;
    if (command == null) return null;
    return (
      text: command['text'] as String,
      replyTo: command['replyTo'] as String?,
      files: _sent?.files ?? const [],
    );
  }

  /// The composer may post now: there is text or a file, and no post or
  /// upload is under way.
  bool get canSend =>
      canPost &&
      _pending == null &&
      !sending &&
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

  /// The person may post here: a writer of the Swarm, in a conversation that
  /// is not archived.
  bool get canPost {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null || group.archived) return false;
    return snapshot.people
            .where((p) => p.id == reader.accountId)
            .firstOrNull
            ?.canWrite ??
        false;
  }

  String get draft => _draft;
  set draft(String value) {
    _draft = value;
    _mentions.removeWhere((_, token) => !containsMention(value, token));
    _composer.changed();
  }

  /// Whether [text] names [token] as a word of its own: the desktop's rule.
  static bool containsMention(String text, String token) =>
      RegExp('(?:^|\\s)${RegExp.escape(token)}(?=\$|\\s|[.,!?;:])')
          .hasMatch(text);

  /// The name typed after an @ that ends the draft — what the mention picker
  /// narrows to; null while the draft does not end in one.
  String? get mentionQuery =>
      RegExp(r'(?:^|\s)@(\S*)$').firstMatch(_draft)?.group(1);

  /// [id]'s name — an agent's or a person's — in place of the @ being typed
  /// ([mentionQuery]), as [mention] adds it.
  void completeMention(String id) {
    if (mentionQuery case final query?) {
      _draft = _draft.substring(0, _draft.length - query.length - 1);
    }
    mention(id);
  }

  /// Adds [id]'s name to the draft: an agent's (the post goes to it) or a
  /// person's username (the post tags them), while the name stays in the
  /// text.
  void mention(String id) {
    final snapshot = reader.snapshot;
    if (snapshot == null) return;
    final person = snapshot.people.where((p) => p.id == id).firstOrNull;
    final token = '@${person?.username ?? snapshot.agentName(id)}';
    final spaced = _draft.isEmpty || RegExp(r'\s$').hasMatch(_draft);
    _draft = '$_draft${spaced ? '' : ' '}$token ';
    _mentions[id] = token;
    _composer.changed();
  }

  /// The agents a post can mention: those in this conversation.
  List<SuperTabAgent> get mentionable {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null) return const [];
    return [for (final agentId in group.agentIds) ?snapshot.agent(agentId)];
  }

  /// The people a post can tag, as Desktop offers them: those who read this
  /// conversation, never the reader. Nobody in the Leads conversation; in a
  /// Buddy chat only its owner reads it. The backend checks each tag again.
  List<SuperTabPerson> get mentionablePeople {
    final snapshot = reader.snapshot;
    final group = conversation;
    if (snapshot == null || group == null || group.kind == 'leads') {
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
            project.memberIds.contains(person.id),
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
        _pending != null ||
        _replyingTo != null ||
        error != null;
    _refused = true;
    _forget();
    _draft = '';
    _threadDrafts.clear();
    // A thread's files go too; its own screen hears it and gives up theirs.
    for (final box in _threadFiles.values) {
      box.clear();
    }
    _threadFiles.clear();
    _mentions.clear();
    _pending = null;
    _sent = null;
    _replyingTo = null;
    _reacting.clear();
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
    final epoch = _epoch;
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
        if (byId[m.id] case final shown? when _same(shown, m)) continue;
        byId[m.id] = m;
        changed = true;
      }
      if (changed) {
        messages = List.unmodifiable(
          byId.values.toList()..sort(superTabMessageOrder),
        );
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
  /// reply to [replyingTo] — or, while a post is [unconfirmed], sends that one
  /// again. The files go up first, one by one, the draft and the files staying
  /// in the composer meanwhile; then the post leaves the draft at once, with
  /// the files, and shows as [pending] until it is read back. True once the
  /// backend took it.
  Future<bool> send() async {
    if (sending || uploading || _disposed || !canPost) return false;
    var pending = _pending;
    if (pending == null) {
      final outgoing = files.files;
      if ((_draft.trim().isEmpty && outgoing.isEmpty) || conversation == null) {
        return false;
      }
      final ids = await _uploadAll(outgoing);
      if (ids == null || _disposed) return false;
      pending = _compose(ids);
      if (pending == null) return false;
      _sent = (
        draft: _draft,
        mentions: Map.of(_mentions),
        replyTo: _replyingTo,
        files: outgoing,
      );
      _draft = '';
      _mentions.clear();
      _replyingTo = null;
      // Only what goes with this post: more may have been added meanwhile.
      for (final file in outgoing) {
        files.remove(file);
      }
    }
    _pending = pending;
    sending = true;
    error = null;
    _tell();
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: pending,
      );
    } on SuperTabFailure catch (failure) {
      // A definitive refusal made no change: the text goes back to the draft
      // to correct. A lost answer keeps its receipt, so a retry is the same
      // post.
      final status = failure.statusCode;
      if (status >= 400 && status < 500 && status != 408 && status != 429) {
        // A refusal of the files themselves sends them up once more; one of
        // the post (a mention, a recipient) leaves them uploaded.
        if (failure.code.contains('ATTACHMENT')) {
          _uploads.forget(_sent?.files ?? const []);
        }
        _pending = null;
        _restore();
      }
      error = failure.message;
      return false;
    } catch (_) {
      error = 'Your message was not sent. Retry to check it.';
      return false;
    } finally {
      sending = false;
      if (!_disposed) _tell();
    }
    _uploads.forget(_sent?.files ?? const []);
    unawaited(reader.refresh());
    // Shown as on its way until the read that brings it back.
    await load();
    if (_disposed || !identical(_pending, pending)) return true;
    _pending = null;
    _sent = null;
    _tell();
    return true;
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
      a.attachments.length == b.attachments.length &&
      _sameReactions(a.reactions, b.reactions);

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

  /// A refused post's text back in the draft, before anything typed since.
  void _restore() {
    final sent = _sent;
    _sent = null;
    if (sent == null) return;
    _draft = _draft.trim().isEmpty ? sent.draft : '${sent.draft}\n$_draft';
    _mentions.addAll(sent.mentions);
    _replyingTo ??= sent.replyTo;
    if (sent.files.isNotEmpty) {
      final since = files.files;
      files
        ..clear()
        ..add([...sent.files, ...since]);
    }
  }

  Map<String, dynamic>? _compose([List<String> attachmentIds = const []]) {
    final text = _draft.trim();
    final group = conversation;
    final people = {...?reader.snapshot?.people.map((p) => p.id)};
    if ((text.isEmpty && attachmentIds.isEmpty) || group == null) return null;
    // A person still in the Swarm whose username the text still says is
    // tagged, as Desktop sends it; the backend refuses one who cannot read.
    final tagged = [
      for (final MapEntry(key: id, value: token) in _mentions.entries)
        if (containsMention(text, token) && people.contains(id)) id,
    ];
    return {
      'operationId': superTabOperationId(),
      'command': {
        'type': 'message.send',
        'conversationId': id,
        'text': text,
        'replyTo': _replyingTo?.id,
        'recipientIds': [
          for (final MapEntry(key: agentId, value: token) in _mentions.entries)
            if (containsMention(text, token) &&
                group.agentIds.contains(agentId))
              agentId,
        ],
        if (tagged.isNotEmpty) 'mentions': tagged,
        if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
      },
    };
  }

  @override
  void dispose() {
    _disposed = true;
    _uploads.close();
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
