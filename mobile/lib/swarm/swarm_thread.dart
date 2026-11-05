import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/phone/voice_recorder.dart' show VoiceTake;

import 'model.dart';
import 'swarm_buddy_sessions.dart';
import 'swarm_conversation.dart';
import 'swarm_outbox.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_uploads.dart';
import 'swarm_voice_send.dart';

/// Where a thread opens: on one of its messages, or at its first unread
/// reply — the newest when all are read. Activity, a link and a tag open a
/// thread this way, so the person does not scroll to find what they came for.
class SwarmThreadFocus {
  const SwarmThreadFocus.message(String this.messageId) : after = null;
  const SwarmThreadFocus.firstUnread({this.after}) : messageId = null;

  /// The message to land on; null for the first unread reply.
  final String? messageId;

  /// For the first unread reply: the sequence the thread was read through
  /// when the person asked, which opening it may since have moved. Null reads
  /// the thread's mark as the page opens.
  final int? after;

  bool get firstUnread => messageId == null;

  /// How many pages of earlier replies are read to find [messageId], as many
  /// as the chat reads back to a quoted message.
  static const maxEarlierPages = 50;
}

/// One thread of a chat on the phone: its root, its replies and the reply
/// box — the desktop's thread panel (`SuperTabThreadPanel`) and what its
/// controller does for it (`loadThread`, `sendThreadReply`).
///
/// Read through its [chat]'s own messages path, so it reads only what the
/// chat may: the newest [pagesOnOpen] pages of replies when it opens, earlier
/// ones on demand ([loadEarlier]), and the root by itself when no page
/// brought it. Replies that arrive later come with the chat's own reads,
/// which keep running under it. Nothing of it stays once the person cannot
/// read the chat: its rows, its draft, its files and a reply not confirmed.
///
/// Files go with a reply as they go with a post in the chat: the same
/// picker, limits and upload ([SwarmUploads]) to the chat's conversation,
/// before the reply. They wait in the chat's box for this thread
/// ([SwarmConversation.threadFiles]) while the chat is open.
///
/// An @ names people and agents as in the chat's composer ([SwarmMentioning],
/// the desktop thread panel's `@`): a reply goes to the agents it names and
/// tags the people.
class SwarmThread extends ChangeNotifier
    with SwarmMentioning
    implements SwarmFilesBox {
  SwarmThread(this.chat, this.root)
    : _draft = chat.threadDraft(root),
      files = chat.threadFiles(root) {
    restoreMentions(chat.threadMentions(root));
    keepMentionsOf(_draft);
    _listed = chat.conversation != null;
    chat.addListener(_chatChanged);
    reader.addListener(_chatChanged);
    files.addListener(_filesChanged);
    final posts = [
      for (final row
          in reader.kept?.posts(reader.tabId, chat.id, root) ?? const [])
        ?SwarmPost.fromKept(row, (text) => _heldOf(text, row)),
    ];
    if (posts.isNotEmpty) _outbox.restore(posts);
  }

  /// What a kept reply puts back in the box if it is refused: its words and
  /// those they named ([mentionsSent]), so they go with it again.
  Object? _heldOf(String text, Map<String, dynamic> row) => (
    draft: text,
    mentions: switch (row['body']) {
      {'command': final Map<String, dynamic> command} => mentionsSent(
        command,
        text,
      ),
      _ => const <String, String>{},
    },
    alsoSend: false,
    newSession: false,
  );

  void _keepPosts() {
    if (_disposed) return;
    reader.kept?.setPosts(reader.tabId, chat.id, root, [
      for (final post in _outbox.posts)
        if (post.state != SwarmPostState.confirmed) post.kept,
    ]);
  }

  /// Takes [post], Not sent, away for good: Delete. It may still have arrived,
  /// and then it shows when the thread is next read.
  void deletePost(SwarmPost post) {
    if (_disposed || post.state != SwarmPostState.unconfirmed) return;
    _uploads.forget(post.files);
    _outbox.remove(post);
    if (error != null && error == _postError && _outbox.unconfirmed == null) {
      error = null;
      _tell();
    }
  }

  final SwarmConversation chat;

  /// The id of the message the thread hangs from.
  final String root;

  /// The files waiting to go with the next reply.
  @override
  final SwarmOutgoingFiles files;

  late final _uploads = SwarmUploads(
    reader,
    chat.id,
    timeout: chat.uploadTimeout,
    onChanged: () {
      if (!_disposed) _tell();
    },
    onProgress: () {
      if (!_disposed) _composer.changed();
    },
  );

  /// The reply's files are on their way, before the reply.
  bool get uploading => _uploads.uploading;

  @override
  bool isUploading(SwarmOutgoingFile file) => _uploads.isUploading(file);

  @override
  double? uploadProgress(SwarmOutgoingFile file) => _uploads.progress(file);

  @override
  SwarmReader get reader => chat.reader;

  /// How many pages a thread reads when it opens; past them "Show earlier
  /// replies" reads on, a page at a time (the desktop's `threadPagesOnOpen`).
  static const pagesOnOpen = 5;

  /// What its own reads brought, oldest first.
  List<SuperTabMessage> _rows = const [];

  /// Where its earlier replies continue, while there are more.
  SuperTabPage? _before;

  bool _read = false, _refused = false, _disposed = false;

  /// The chat was in its Swarm's read: one that then leaves it hides the
  /// thread at once, as the chat hides its messages.
  late bool _listed;

  Future<void>? _reading;

  /// "Show earlier replies" is being read.
  bool readingEarlier = false;

  /// Moves when what was read is dropped: a read asked for before then
  /// answers nothing.
  int _epoch = 0;

  /// What the last read or reply could not do, as a sentence.
  String? error;

  /// Why the thread could not be read when it opened, until a read succeeds:
  /// what the chat has of it shows, with Try again.
  String? get readError => _readError;
  String? _readError;

  /// The root and its replies, oldest first: what its own reads brought and
  /// what the chat has read of it since (the desktop's `threadMessages`).
  /// None once the person cannot read it.
  List<SuperTabMessage> get messages {
    if (state == SwarmChatState.lost) return const [];
    final chatRows = chat.messages;
    if (!identical(_madeFrom?.$1, _rows) ||
        !identical(_madeFrom?.$2, chatRows)) {
      final byId = {
        // A reply the chat found deleted goes from the thread too.
        for (final m in _rows)
          if (!chat.gone(m.id)) m.id: m,
        for (final m in chatRows)
          if (m.thread == root) m.id: m,
      };
      _messages = List.unmodifiable(
        byId.values.toList()..sort(superTabMessageOrder),
      );
      _madeFrom = (_rows, chatRows);
    }
    return _messages;
  }

  List<SuperTabMessage> _messages = const [];
  (List<SuperTabMessage>, List<SuperTabMessage>)? _madeFrom;

  /// The message the thread hangs from, once read.
  SuperTabMessage? get rootMessage =>
      messages.where((m) => m.id == root).firstOrNull;

  /// Its replies, oldest first.
  List<SuperTabMessage> get replies => [
    for (final m in messages)
      if (m.id != root) m,
  ];

  /// How many replies it has: as its line says, else as many as were read.
  int get count => chat.thread(root)?.replies ?? replies.length;

  /// Replies before those read wait to be read.
  bool get hasEarlier => _before != null;

  /// Where the thread stands: a skeleton, its messages, or not open.
  SwarmChatState get state => _refused || chat.state == SwarmChatState.lost
      ? SwarmChatState.lost
      : _read
      ? SwarmChatState.loaded
      : SwarmChatState.loading;

  /// The person may reply: as they may post in the chat.
  bool get canPost => chat.canPost;

  /// The person sees the thread: read through its newest row on every device
  /// (backend readMarks.ts thread marks), once its own read brought it.
  void markRead() {
    if (_disposed || reader.accessRevoked || state != SwarmChatState.loaded) {
      return;
    }
    final last = messages.lastOrNull?.sequence ?? 0;
    if (last > 0) reader.readMarks?.markThreadRead(chat.id, root, last);
  }

  /// Tells the reply box what changed in it — the draft, Also send, a reply
  /// leaving it — while this notifier itself tells the messages.
  Listenable get composer => _composer;
  final _composer = _Changes();

  String _draft;
  @override
  String get draft => _draft;
  @override
  set draft(String value) {
    _draft = value;
    keepMentionsOf(value);
    chat.setThreadDraft(root, value, mentions);
    _composer.changed();
  }

  /// The agents a reply can name: the chat's, but none where the thread's
  /// own session alone hears the reply (Desktop's thread `_tagChoices`).
  List<SuperTabAgent> get mentionable =>
      newSession || session != null ? const [] : chat.mentionable;

  /// The people a reply can tag: the chat's.
  List<SuperTabPerson> get mentionablePeople => chat.mentionablePeople;

  /// The reply also goes to the chat's main stream.
  bool get alsoSend => _alsoSend;
  bool _alsoSend = false;
  set alsoSend(bool value) {
    if (_alsoSend == value) return;
    _alsoSend = value;
    _composer.changed();
  }

  /// New session is chosen for the next reply (Desktop's thread composer).
  bool _newSession = false;

  /// The person's own Buddy chat, on a server that takes New session for a
  /// reply — with a Buddy, or in a thread that had a session, whose reply
  /// must start a new one.
  bool get _sessionsPossible {
    final group = chat.conversation;
    return group != null &&
        canPost &&
        swarmOffersThreadSessions(reader, group, hadSession: _hadSession);
  }

  /// Whether the box shows New session: [_sessionsPossible], in a thread no
  /// session answers now (Desktop's `_offersSession`). It may still show
  /// disabled, saying why ([sessionBlocked]).
  bool get offersSessions => _sessionsPossible && session == null;

  /// Whether the box shows Also send: not in a session's thread, which stays
  /// in the thread, nor for a reply that starts a session.
  bool get offersAlsoSend => !newSession && session == null;

  /// Why a session cannot start now; null when it can.
  String? get sessionBlocked {
    final group = chat.conversation;
    return group == null || !_sessionsPossible
        ? null
        : swarmSessionBlocked(reader, group);
  }

  /// A reply from or to a thread session is in the thread.
  bool get _hadSession => messages.any((m) => m.buddySession);

  /// The live or starting session answering the thread; null when none does,
  /// or in a chat that is not the person's own Buddy chat. Shown whether or
  /// not New session is offered.
  SuperTabBuddySession? get session {
    final group = chat.conversation;
    return group == null || !swarmOwnBuddyChat(reader, group)
        ? null
        : group.sessionFor(root);
  }

  /// The row saying the thread's last session ended (its ended line, else its
  /// last session reply), while no session answers it: a plain reply would be
  /// refused, so a new one must start.
  SuperTabMessage? get sessionEndedRow {
    final group = chat.conversation;
    if (group == null || !swarmOwnBuddyChat(reader, group) || session != null) {
      return null;
    }
    final rows = messages;
    return rows.where((m) => m.sessionEnded).lastOrNull ??
        rows.where((m) => m.buddySession).lastOrNull;
  }

  /// The thread's session ended: New session shows on and locked.
  bool get sessionLocked => _sessionsPossible && sessionEndedRow != null;

  /// Whether the next reply starts a session: locked, or chosen and not
  /// blocked.
  bool get newSession =>
      offersSessions &&
      (sessionLocked || (_newSession && sessionBlocked == null));
  set newSession(bool value) {
    if (_newSession == value) return;
    _newSession = value;
    _composer.changed();
  }

  /// Ends the thread's session ([SwarmConversation.endSession]).
  Future<bool> endSession() async {
    if (_disposed) return false;
    final done = await chat.endSession(root);
    if (_disposed) return done;
    // Said where the person pressed it: this page shows the thread's error.
    if (!done && chat.endRefusal != null) error = chat.endRefusal;
    _tell();
    return done;
  }

  /// An end is under way for the thread's session.
  bool get endingSession => chat.endingSession(root);

  /// Where Also send puts a reply, as the desktop names the chat.
  String get alsoSendLabel {
    final group = chat.conversation;
    if (group != null && reader.snapshot?.isProjectLead(group.id) == true) {
      return 'Also send to the project chat';
    }
    return group?.number != null
        ? 'Also send to the workgroup'
        : 'Also send to the chat';
  }

  /// A reply is on its way.
  bool get sending => _outbox.sending;

  /// The person's replies on their way, each sent on its own and — while its
  /// answer never came — retried under its own operation id, so the backend
  /// runs it once.
  late final SwarmOutbox _outbox = SwarmOutbox(
    request: reader.request,
    path: '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
    timeout: chat.sendTimeout,
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
      // Shown as sent until a read brings it back: the chat's, or this one.
      unawaited(chat.loadFromNow());
    },
    onRefused: (post) {
      if (_disposed) return;
      final failure = post.refusedBy!;
      if (_refusedChat(failure)) return;
      // A refusal of the files themselves sends them up once more; one of
      // the reply leaves them uploaded.
      if (failure.code.contains('ATTACHMENT')) _uploads.forget(post.files);
      _restore(post);
      if (swarmRefusedForSessions(post)) {
        swarmSessionsRefused(reader);
        error = swarmSessionsUnavailable;
      } else {
        error = post.error;
      }
    },
  );

  /// The [error] a reply's lost answer set: its later answer takes it back.
  String? _postError;

  /// The replies on their way, taken or not confirmed, oldest first: drawn
  /// under the replies, each "Sending…", as sent, or "Not sent · Retry",
  /// until a read brings it back.
  List<SwarmPost> get outgoing => _outbox.posts;

  /// A reply was sent and not confirmed: [send] with nothing typed, or
  /// [retry], sends it again.
  bool get unconfirmed => _outbox.unconfirmed != null;

  /// The box may send now: there is text or a file, and no upload is under
  /// way. A reply on its way never holds the next one back.
  bool get canSend =>
      canPost &&
      !uploading &&
      (_draft.trim().isNotEmpty || files.files.isNotEmpty);

  /// Taking a file off while the files go up gives the upload up.
  void _filesChanged() {
    _uploads.keepTo(files.files);
    if (!_disposed) _composer.changed();
  }

  /// The chat or its Swarm changed: replies read since show, and a thread the
  /// person can no longer read keeps nothing.
  void _chatChanged() {
    if (_disposed) return;
    if (reader.accessRevoked || chat.state == SwarmChatState.lost) {
      _lose();
      return;
    }
    if (reader.snapshot != null) {
      final listed = chat.conversation != null;
      if (_listed && !listed) {
        // Taken out of the chat: what was read of it goes at once.
        _forget();
      } else if (!_listed && listed && !_read && error == null) {
        unawaited(load());
      }
      _listed = listed;
    }
    _settle();
    notifyListeners();
  }

  /// Drops what was read, and the answer of any read under way.
  void _forget() {
    _rows = const [];
    _before = null;
    _read = false;
    _readError = null;
    readingEarlier = false;
    _reading = null;
    _epoch++;
  }

  /// The person cannot read the chat: nothing of the thread stays.
  void _lose() {
    final held =
        !_refused ||
        _rows.isNotEmpty ||
        _draft.isNotEmpty ||
        files.files.isNotEmpty ||
        uploading ||
        !_outbox.isEmpty ||
        error != null;
    _refused = true;
    _forget();
    // The files on their way stop, and none stays in the box.
    _uploads.cancel();
    files.clear();
    _draft = '';
    forgetMentions();
    _alsoSend = false;
    _outbox.clear();
    error = null;
    if (held) _tell();
  }

  /// The backend refused [failure] as a chat that is not the person's: the
  /// thread keeps nothing, as when access is revoked, and the chat learns it
  /// from a read of its own. False for any other refusal.
  bool _refusedChat(SuperTabFailure failure) {
    if (!const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) return false;
    _lose();
    unawaited(chat.load());
    return true;
  }

  /// A reply read back shows as its row, once, no longer on its way —
  /// whatever its answer, which may still be coming.
  void _settle() {
    if (_outbox.settle(messages)) {
      _keepPosts();
      _composer.changed();
    }
  }

  /// Reads the thread: from its newest reply back through [pagesOnOpen]
  /// pages, and its root when no page brought it. Joins a read under way.
  Future<void> load() =>
      _reading ??= _load(earlier: false).whenComplete(() => _reading = null);

  /// Reads the page of replies before those read.
  Future<void> loadEarlier() async {
    if (!hasEarlier || readingEarlier || _reading != null) return;
    readingEarlier = true;
    notifyListeners();
    await (_reading = _load(earlier: true).whenComplete(() => _reading = null));
  }

  Future<void> _load({required bool earlier}) async {
    if (_disposed ||
        reader.accessRevoked ||
        chat.state == SwarmChatState.lost) {
      return;
    }
    final epoch = _epoch;
    final path = chat.messagesPath;
    final thread = Uri.encodeQueryComponent(root);
    // Still open, still readable: an answer that comes back after access went
    // or the chat was left is not kept.
    bool current() =>
        !_disposed &&
        epoch == _epoch &&
        !reader.accessRevoked &&
        chat.conversation != null;
    List<SuperTabMessage> rowsOf(Object? answer) => [
      for (final row in superTabMap(answer)['messages'] as List)
        if (SuperTabMessage.fromJson(superTabMap(row)) case final m
            when m.conversationId == chat.id && m.thread == root)
          m,
    ];
    try {
      final rows = {
        if (earlier)
          for (final m in _rows) m.id: m,
      };
      var from = earlier ? _before : null;
      Object? threads;
      for (var page = 0; page < (earlier ? 1 : pagesOnOpen); page++) {
        final answer = superTabMap(
          await reader.request(
            'GET',
            from == null
                ? '$path?thread=$thread'
                : '$path?thread=$thread&before=${from.sequence}'
                      '&beforeId=${Uri.encodeQueryComponent(from.id)}',
          ),
        );
        if (!current()) return;
        threads ??= answer['threads'];
        for (final m in rowsOf(answer)) {
          rows[m.id] = m;
        }
        from = SuperTabPage.read(answer['next']);
        if (from == null) break;
      }
      // A long thread's pages read so far start after its root.
      if (!rows.containsKey(root) && !chat.messages.any((m) => m.id == root)) {
        final answer = await reader.request(
          'GET',
          '$path?messageId=${Uri.encodeQueryComponent(root)}',
        );
        if (!current()) return;
        for (final m in rowsOf(answer)) {
          if (m.id == root) rows[m.id] = m;
        }
      }
      _rows = List.unmodifiable(
        rows.values.toList()..sort(superTabMessageOrder),
      );
      _before = from;
      _read = true;
      error = _readError = null;
      chat.keepThreads(threads);
      _settle();
    } on SuperTabFailure catch (failure) {
      if (!current()) return;
      if (_refusedChat(failure)) return;
      error = failure.message;
      if (!earlier) _readError = error;
    } catch (_) {
      if (!current()) return;
      error = earlier
          ? 'Could not load earlier replies. Try again.'
          : _readError = 'Could not load the thread. Try again.';
    } finally {
      if (earlier && epoch == _epoch) readingEarlier = false;
    }
    if (!_disposed) notifyListeners();
  }

  /// Adds the person's [emoji] to [message], or takes it back (the chat's
  /// [SwarmConversation.react]), then reads the thread's newest page again:
  /// a reply the chat has not read shows the backend's counts too. A refused
  /// reaction has the chat read again, which tells whether it is still open.
  Future<bool> react(
    SuperTabMessage message,
    SuperTabReactionEmoji emoji,
  ) async {
    final done = await chat.react(message, emoji);
    if (_disposed) return done;
    if (done && _read) {
      await _reread();
    } else if (!done && chat.error != null) {
      unawaited(chat.load());
    }
    return done;
  }

  /// Puts [text] in place of [message]'s ([SwarmConversation.editMessage]),
  /// then reads the thread's newest page again so it shows here at once.
  /// Answers why it was refused; null once done or when nothing changed.
  Future<String?> editMessage(SuperTabMessage message, String text) async {
    final refused = await chat.editMessage(message, text);
    if (refused == null && !_disposed && _read) await _reread();
    return refused;
  }

  /// Deletes [message] ([SwarmConversation.deleteMessage]), then reads the
  /// thread's newest page again: a reply leaves it. Answers why it was
  /// refused; null once done.
  Future<String?> deleteMessage(SuperTabMessage message) async {
    final refused = await chat.deleteMessage(message);
    if (refused == null && !_disposed && _read) await _reread();
    return refused;
  }

  /// The thread's newest page again, over the rows read of it: a reply it
  /// covers and no longer has was deleted, and goes. The root stays; deleted,
  /// it is the line its replies hang from.
  Future<void> _reread() async {
    final epoch = _epoch;
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '${chat.messagesPath}?thread=${Uri.encodeQueryComponent(root)}',
        ),
      );
      if (_disposed ||
          epoch != _epoch ||
          reader.accessRevoked ||
          chat.conversation == null) {
        return;
      }
      final rows = {for (final m in _rows) m.id: m};
      final read = <SuperTabMessage>[];
      for (final row in answer['messages'] as List) {
        final m = SuperTabMessage.fromJson(superTabMap(row));
        if (m.conversationId == chat.id && m.thread == root) read.add(m);
      }
      final covers = answer['next'] == null
          ? 0
          : read.isEmpty
          ? null
          : read.map((m) => m.sequence).reduce((a, b) => a < b ? a : b);
      if (covers != null) {
        rows.removeWhere((id, m) => id != root && m.sequence >= covers);
      }
      for (final m in read) {
        rows[m.id] = m;
      }
      _rows = List.unmodifiable(
        rows.values.toList()..sort(superTabMessageOrder),
      );
      chat.keepThreads(answer['threads']);
      _settle();
      notifyListeners();
    } on SuperTabFailure catch (failure) {
      if (_disposed || epoch != _epoch) return;
      // Any other refusal keeps the counts read before.
      _refusedChat(failure);
    } catch (_) {
      // The counts read before stay; the next open reads them again.
    }
  }

  /// Sends [take] as a voice message with attached files in the thread, as the chat's
  /// [SwarmConversation.sendVoice] does: what is typed stays in the box.
  Future<SwarmVoicePosted> sendVoice(VoiceTake take, String lang) async {
    if (uploading || _disposed || !canPost || chat.conversation == null) {
      return (sent: false, notice: null);
    }
    final epoch = _epoch;
    bool current() => !_disposed && epoch == _epoch;
    final attached = files.files;
    if (attached.length >= swarmAttachmentMaxFiles) {
      return (
        sent: false,
        notice: 'Attach at most 9 files with a voice message.',
      );
    }
    final clip = SwarmOutgoingFile(swarmVoiceFileName, take.wav);
    final outgoing = [...attached, clip];
    error = null;
    final up = await _uploads.upload(outgoing);
    if (!current()) return (sent: false, notice: null);
    if (up.failure case final failure?) {
      if (failure is! SuperTabFailure || !_refusedChat(failure)) {
        error = swarmUploadError(failure, outgoing.length);
        _tell();
      }
      return (sent: false, notice: null);
    }
    final ids = up.ids;
    if (ids == null) return (sent: false, notice: null);
    final read = await swarmReadVoice(
      reader.request,
      tabId: reader.tabId,
      attachmentId: ids.last,
      lang: lang,
    );
    final voice = read.voice;
    if (!current() || voice == null) return (sent: false, notice: read.refused);
    final operationId = superTabOperationId();
    final post = SwarmPost(
      body: {
        'operationId': operationId,
        'command': {
          'type': 'message.send',
          'conversationId': chat.id,
          'text': '',
          'replyTo': root,
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
      files: outgoing,
      voice: voice,
      held: (voiceFiles: attached),
    );
    for (final file in attached) {
      files.remove(file);
    }
    final outcome = await _outbox.add(post);
    _answered(post, outcome, current);
    final sent =
        outcome == SwarmPostOutcome.taken || outcome == SwarmPostOutcome.lost;
    // It says nothing once sent: a voice message plays only, and never
    // has words to go without (anh Dee, 2026-11-04).
    return (sent: sent, notice: null);
  }

  /// Sends the draft to the thread's root, to the agents it names and tagging
  /// the people it names, also to the chat with [alsoSend]
  /// — or, with nothing typed while a reply is [unconfirmed], sends that one
  /// again. The reply leaves the box at once and shows in [outgoing] until it
  /// is read back; one on its way never holds this one back. True once the
  /// backend took it.
  Future<bool> send() async {
    if (uploading || _disposed || !canPost) return false;
    // An answer that comes back after the thread closed, or after what it
    // held was dropped, changes nothing: no text or files back in a box.
    final epoch = _epoch;
    bool current() => !_disposed && epoch == _epoch;
    final outgoing = files.files;
    if (_draft.trim().isEmpty && outgoing.isEmpty) {
      final again = _outbox.unconfirmed;
      return again != null && await retry(again);
    }
    final listed = chat.conversation;
    if (listed == null) return false;
    // As the desktop's, before any file goes up: an agent picked for the
    // reply who has left the chat since is never dropped without a word.
    if (namesAgentGone(_draft, listed.agentIds)) {
      error = swarmMentionedAgentLeft;
      _tell();
      return false;
    }
    if (_namesAgentInSession) {
      // As the desktop's, before any file goes up.
      error =
          "Only this thread's session hears a reply here. "
          "Remove the agent's mention.";
      _tell();
      return false;
    }
    // The files go up first, the draft and the files staying in the box
    // meanwhile, as the chat's do.
    var ids = const <String>[];
    if (outgoing.isNotEmpty) {
      error = null;
      final up = await _uploads.upload(outgoing);
      if (!current()) return false;
      if (up.failure case final failure?) {
        if (failure is SuperTabFailure && _refusedChat(failure)) {
          return false;
        }
        error = swarmUploadError(failure, outgoing.length);
        _tell();
        return false;
      }
      ids = up.ids ?? const [];
      if (up.ids == null) return false;
    }
    final text = _draft.trim();
    final group = chat.conversation;
    if ((text.isEmpty && ids.isEmpty) || group == null) {
      return false;
    }
    final (:tagged, :addressed) = mentionsSaid(text, group.agentIds);
    final operationId = superTabOperationId();
    final startsSession = newSession;
    final post = SwarmPost(
      body: {
        'operationId': operationId,
        'command': {
          'type': 'message.send',
          'conversationId': chat.id,
          'text': text,
          'replyTo': root,
          'recipientIds': addressed,
          if (tagged.isNotEmpty) 'mentions': tagged,
          // A session's thread stays in the thread: never also sent.
          if (_alsoSend && offersAlsoSend) 'alsoSend': true,
          if (startsSession) 'newSession': true,
          if (ids.isNotEmpty) 'attachmentIds': ids,
          // As the desktop's: the server refuses it in an older Buddy chat.
          if (reader.snapshot?.swarmBuddy == true) 'oneBuddy': true,
        },
      },
      messageId: superTabMessageId(
        tabId: reader.tabId,
        accountId: reader.accountId,
        operationId: operationId,
      ),
      files: outgoing,
      held: (
        draft: _draft,
        mentions: mentions,
        alsoSend: _alsoSend,
        newSession: _newSession,
      ),
    );
    _draft = '';
    forgetMentions();
    chat.setThreadDraft(root, '');
    _alsoSend = false;
    _newSession = false;
    // Only what goes with this reply: more may have been added meanwhile.
    for (final file in outgoing) {
      files.remove(file);
    }
    error = null;
    return _answered(post, await _outbox.add(post), current);
  }

  /// The draft names an agent where the thread's own session alone hears a
  /// reply (backend routeBuddySession), which would refuse it.
  bool get _namesAgentInSession {
    final group = chat.conversation;
    return group != null &&
        (newSession || session != null) &&
        mentionsSaid(_draft, group.agentIds).addressed.isNotEmpty;
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
    final epoch = _epoch;
    error = null;
    return _answered(
      post,
      await _outbox.deliver(post),
      () => !_disposed && epoch == _epoch,
    );
  }

  /// What [post]'s try came to, said: a refusal puts its text back in the
  /// box, a lost answer says Not sent.
  bool _answered(
    SwarmPost post,
    SwarmPostOutcome outcome,
    bool Function() current,
  ) {
    if (!current()) return outcome == SwarmPostOutcome.taken;
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

  /// A refused reply's text and files back in the box, before anything
  /// typed or added since.
  void _restore(SwarmPost post) {
    if (post.held case (voiceFiles: final List<SwarmOutgoingFile> attached)) {
      final since = files.files;
      files
        ..clear()
        ..add([...attached, ...since]);
      return;
    }
    final sent = post.held;
    if (sent
        is! ({
          String draft,
          Map<String, String> mentions,
          bool alsoSend,
          bool newSession,
        })) {
      return;
    }
    // Picked again first: the draft keeps those its text names.
    restoreMentions(sent.mentions);
    draft = _draft.trim().isEmpty ? sent.draft : '${sent.draft}\n$_draft';
    _alsoSend = _alsoSend || sent.alsoSend;
    // Refused for New session itself, it comes back as a plain reply.
    if (!swarmRefusedForSessions(post)) {
      _newSession = _newSession || sent.newSession;
    }
    if (post.files.isNotEmpty) {
      final since = files.files;
      files
        ..clear()
        ..add([...post.files, ...since]);
    }
  }

  /// A reply moved between the box and the messages: both are told.
  void _tell() {
    notifyListeners();
    _composer.changed();
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    // An upload on its way stops; the files wait in the chat's box.
    _uploads.close();
    _outbox.close();
    files.removeListener(_filesChanged);
    chat.releaseThreadFiles(root, files);
    chat.removeListener(_chatChanged);
    reader.removeListener(_chatChanged);
    _composer.dispose();
    super.dispose();
  }
}

/// A notifier told from outside it: the thread's [SwarmThread.composer].
class _Changes extends ChangeNotifier {
  void changed() => notifyListeners();
}
