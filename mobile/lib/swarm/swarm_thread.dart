import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_conversation.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_uploads.dart';

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
class SwarmThread extends ChangeNotifier implements SwarmFilesBox {
  SwarmThread(this.chat, this.root)
    : _draft = chat.threadDraft(root),
      files = chat.threadFiles(root) {
    _listed = chat.conversation != null;
    chat.addListener(_chatChanged);
    reader.addListener(_chatChanged);
    files.addListener(_filesChanged);
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
        for (final m in _rows) m.id: m,
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

  /// Tells the reply box what changed in it — the draft, Also send, a reply
  /// leaving it — while this notifier itself tells the messages.
  Listenable get composer => _composer;
  final _composer = _Changes();

  String _draft;
  String get draft => _draft;
  set draft(String value) {
    _draft = value;
    chat.setThreadDraft(root, value);
    _composer.changed();
  }

  /// The reply also goes to the chat's main stream.
  bool get alsoSend => _alsoSend;
  bool _alsoSend = false;
  set alsoSend(bool value) {
    if (_alsoSend == value) return;
    _alsoSend = value;
    _composer.changed();
  }

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
  bool sending = false;

  /// The reply on its way, then — while its answer never came — retried
  /// under the same operation id, so the backend runs it once.
  Map<String, dynamic>? _pending;

  /// What the box held when [_pending] left it: a refusal puts it back.
  ({String draft, bool alsoSend, List<SwarmOutgoingFile> files})? _sent;

  /// The reply on its way or not confirmed: drawn under the replies,
  /// "Sending…" and then [unconfirmed], until it is read back.
  String? get pending => (_pending?['command'] as Map?)?['text'] as String?;

  /// The files that went with [pending].
  List<SwarmOutgoingFile> get pendingFiles => _sent?.files ?? const [];

  /// The backend took the reply on its way, which no read has brought back
  /// yet: it stays on its way, and is not sent again.
  bool get confirmed => _confirmed;
  bool _confirmed = false;

  /// A reply was sent and not confirmed: [send] retries it.
  bool get unconfirmed => _pending != null && !sending && !_confirmed;

  /// The box may send now: there is text or a file, and no reply or upload
  /// is under way.
  bool get canSend =>
      canPost &&
      _pending == null &&
      !sending &&
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
        _pending != null ||
        error != null;
    _refused = true;
    _forget();
    // The files on their way stop, and none stays in the box.
    _uploads.cancel();
    files.clear();
    _draft = '';
    _alsoSend = false;
    _pending = null;
    _sent = null;
    _confirmed = false;
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

  /// A confirmed reply read back shows as its row, no longer on its way.
  void _settle() {
    if (!_confirmed) return;
    final id = _pending?['operationId'];
    if (!messages.any((m) => m.id == id)) return;
    _pending = null;
    _sent = null;
    _confirmed = false;
    _composer.changed();
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

  /// The thread's newest page again, over the rows read of it.
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
      for (final row in answer['messages'] as List) {
        final m = SuperTabMessage.fromJson(superTabMap(row));
        if (m.conversationId == chat.id && m.thread == root) rows[m.id] = m;
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

  /// Sends the draft to the thread's root, also to the chat with [alsoSend]
  /// — or, while a reply is [unconfirmed], sends that one again. The reply
  /// leaves the box at once and shows as [pending] until it is read back.
  /// True once the backend took it.
  Future<bool> send() async {
    if (sending || uploading || _confirmed || _disposed || !canPost) {
      return false;
    }
    // An answer that comes back after the thread closed, or after what it
    // held was dropped, changes nothing: no text or files back in a box, no
    // read.
    final epoch = _epoch;
    bool current() => !_disposed && epoch == _epoch;
    var pending = _pending;
    if (pending == null) {
      final outgoing = files.files;
      if ((_draft.trim().isEmpty && outgoing.isEmpty) ||
          chat.conversation == null) {
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
      if ((text.isEmpty && ids.isEmpty) || chat.conversation == null) {
        return false;
      }
      pending = {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'message.send',
          'conversationId': chat.id,
          'text': text,
          'replyTo': root,
          'recipientIds': const <String>[],
          if (_alsoSend) 'alsoSend': true,
          if (ids.isNotEmpty) 'attachmentIds': ids,
        },
      };
      _sent = (draft: _draft, alsoSend: _alsoSend, files: outgoing);
      _draft = '';
      chat.setThreadDraft(root, '');
      _alsoSend = false;
      // Only what goes with this reply: more may have been added meanwhile.
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
      if (current()) _confirmed = true;
    } on SuperTabFailure catch (failure) {
      if (!current() || _refusedChat(failure)) return false;
      // A definitive refusal made no change: the text goes back to the box
      // to correct. A lost answer keeps its receipt, so a retry is the same
      // reply.
      final status = failure.statusCode;
      if (status >= 400 && status < 500 && status != 408 && status != 429) {
        // A refusal of the files themselves sends them up once more; one of
        // the reply leaves them uploaded.
        if (failure.code.contains('ATTACHMENT')) _uploads.forget(pendingFiles);
        _pending = null;
        _restore();
      }
      error = failure.message;
      return false;
    } catch (_) {
      if (!current()) return false;
      error = 'Your reply is not confirmed. Send again to check it.';
      return false;
    } finally {
      sending = false;
      if (!_disposed) _tell();
    }
    if (!current()) return true;
    _uploads.forget(pendingFiles);
    unawaited(reader.refresh());
    // On its way until a read brings it back: this one, or the chat's next.
    await chat.load();
    if (!current() || !identical(_pending, pending)) return true;
    _settle();
    _tell();
    return true;
  }

  /// A refused reply's text and files back in the box, before anything
  /// typed or added since.
  void _restore() {
    final sent = _sent;
    _sent = null;
    if (sent == null) return;
    draft = _draft.trim().isEmpty ? sent.draft : '${sent.draft}\n$_draft';
    _alsoSend = _alsoSend || sent.alsoSend;
    if (sent.files.isNotEmpty) {
      final since = files.files;
      files
        ..clear()
        ..add([...sent.files, ...since]);
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
