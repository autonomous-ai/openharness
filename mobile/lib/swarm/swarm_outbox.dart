import 'dart:async';
import 'dart:convert';

import 'package:cryptography/dart.dart' show DartSha256;

import 'model.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_request.dart';

/// The id the backend gives the message a person sends with receipt
/// [operationId]: `stableId(state.id, actorKey(actor), operationId)`, the
/// first 24 hex of sha256 over the JSON of those parts (backend
/// superTabs/commands.ts `message.send`, model.ts `stableId`).
String superTabMessageId({
  required String tabId,
  required String accountId,
  required String operationId,
}) => const DartSha256()
    .hashSync(
      utf8.encode(jsonEncode([tabId, 'person:$accountId', operationId])),
    )
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join()
    .substring(0, 24);

/// Where one of the person's posts stands until a read brings it back.
enum SwarmPostState {
  /// On its way: "Sending…".
  sending,

  /// Taken by the backend, not read back yet: drawn as sent, with no line.
  confirmed,

  /// Sent with no answer, or none in time: it may or may not have arrived.
  /// "Not sent · Retry" sends it again under the same receipt, so the
  /// backend posts it once.
  unconfirmed,
}

/// One post of the person's on its way, with what the composer held for it.
class SwarmPost {
  SwarmPost({
    required this.body,
    required this.messageId,
    this.files = const [],
    this.held,
  });

  /// `{operationId, command}`: sent as it is on every try.
  final Map<String, dynamic> body;

  /// The message the backend writes for it: its answer's, else worked out
  /// from the receipt, so a read that brings it before the answer finds it.
  String messageId;

  /// The files that went with it, already uploaded.
  final List<SwarmOutgoingFile> files;

  /// What the composer held when it left (draft, mentions, reply): a refusal
  /// puts it back.
  final Object? held;

  SwarmPostState state = SwarmPostState.sending;

  /// Why its last try did not go through.
  String? error;

  /// The backend's refusal, once it refused it.
  SuperTabFailure? refusedBy;

  int _tries = 0;
  Timer? _timer;

  /// A read brought it back.
  bool _arrived = false;

  /// [SwarmOutbox.onTaken] was told.
  bool _told = false;

  String get operationId => body['operationId'] as String;
  Map<String, dynamic> get command => body['command'] as Map<String, dynamic>;
  String get text => command['text'] as String;
  String? get replyTo => command['replyTo'] as String?;
}

/// What became of one try of [SwarmOutbox.deliver].
enum SwarmPostOutcome {
  /// The backend took it, or a read brought it back.
  taken,

  /// The backend refused it: nothing was posted, and it left the outbox.
  refused,

  /// No answer, or none in time: [SwarmPostState.unconfirmed].
  lost,

  /// The outbox was closed or cleared meanwhile: nobody waits on it.
  gone,
}

/// The person's posts on their way in one chat or thread, oldest first (the
/// desktop's outgoing rows). Each is sent on its own: a second post never
/// waits on the first, as in Slack. A post leaves once a read brings back
/// the backend's copy of it ([settle]), even while its answer is still on
/// its way, so it shows once.
class SwarmOutbox {
  SwarmOutbox({
    required this.request,
    required this.path,
    required this.onChanged,
    required this.onTaken,
    required this.onRefused,
    this.timeout = defaultTimeout,
  });

  /// A send through the account's computers can take 30 seconds a computer
  /// (`AppNotifier.swarmRequest`): past this one, the post says Not sent and
  /// may be sent again, while its first answer may still land.
  static const defaultTimeout = Duration(seconds: 40);

  final SwarmRequest request;

  /// Where commands go.
  final String path;

  /// A post was added, changed state or left.
  final void Function() onChanged;

  /// The backend took [post] (on any try, also after its timeout).
  final void Function(SwarmPost post) onTaken;

  /// The backend refused [post] ([SwarmPost.refusedBy]), whenever its answer
  /// came — also after it said Not sent: its text goes back to the box.
  final void Function(SwarmPost post) onRefused;
  final Duration timeout;

  final _posts = <SwarmPost>[];
  bool _closed = false;

  List<SwarmPost> get posts => List.unmodifiable(_posts);

  bool get isEmpty => _posts.isEmpty;

  /// One is on its way.
  bool get sending => _posts.any((p) => p.state == SwarmPostState.sending);

  /// The oldest post that may not have arrived, which Retry sends again.
  SwarmPost? get unconfirmed =>
      _posts.where((p) => p.state == SwarmPostState.unconfirmed).firstOrNull;

  bool _here(SwarmPost post) => !_closed && _posts.contains(post);

  /// Adds [post] and sends it.
  Future<SwarmPostOutcome> add(SwarmPost post) {
    if (_closed) return Future.value(SwarmPostOutcome.gone);
    _posts.add(post);
    return deliver(post);
  }

  /// Sends [post] — again, when it is [SwarmPostState.unconfirmed] — under
  /// its own receipt, so the backend posts it once however often it goes.
  Future<SwarmPostOutcome> deliver(SwarmPost post) {
    if (!_here(post) || post.state == SwarmPostState.confirmed) {
      return Future.value(
        _here(post) ? SwarmPostOutcome.taken : SwarmPostOutcome.gone,
      );
    }
    if (post.state == SwarmPostState.sending && post._tries > 0) {
      return Future.value(SwarmPostOutcome.lost);
    }
    final tries = ++post._tries;
    post
      ..state = SwarmPostState.sending
      ..error = null;
    onChanged();
    final outcome = Completer<SwarmPostOutcome>();
    void end(SwarmPostOutcome value) {
      if (!outcome.isCompleted) outcome.complete(value);
    }

    bool latest() => _here(post) && post._tries == tries;
    post._timer?.cancel();
    post._timer = Timer(timeout, () {
      if (latest() && post.state == SwarmPostState.sending) {
        post
          ..state = SwarmPostState.unconfirmed
          ..error = 'Your message was not sent. Retry to check it.';
        onChanged();
      }
      end(_here(post) ? SwarmPostOutcome.lost : SwarmPostOutcome.gone);
    });
    request('POST', path, body: post.body).then(
      (answer) {
        if (!_here(post)) {
          // A read brought it back meanwhile, or the chat closed.
          if (post._arrived && !_closed) _taken(post);
          end(post._arrived ? SwarmPostOutcome.taken : SwarmPostOutcome.gone);
          return;
        }
        // Any try's answer is the same command's: it is taken.
        post._timer?.cancel();
        if (_idOf(answer) case final id?) post.messageId = id;
        post
          ..state = SwarmPostState.confirmed
          ..error = null;
        _taken(post);
        onChanged();
        end(SwarmPostOutcome.taken);
      },
      onError: (Object failure) {
        if (!_here(post)) {
          end(post._arrived ? SwarmPostOutcome.taken : SwarmPostOutcome.gone);
          return;
        }
        // One taken stays taken, and a later try speaks for the post.
        if (post.state == SwarmPostState.confirmed) {
          end(SwarmPostOutcome.taken);
          return;
        }
        if (!latest()) {
          end(SwarmPostOutcome.lost);
          return;
        }
        post._timer?.cancel();
        // A definitive refusal made no change; a lost answer keeps its
        // receipt, so a retry is the same post.
        if (failure is SuperTabFailure && refusal(failure)) {
          post
            ..error = failure.message
            ..refusedBy = failure;
          _posts.remove(post);
          onRefused(post);
          onChanged();
          end(SwarmPostOutcome.refused);
          return;
        }
        post
          ..state = SwarmPostState.unconfirmed
          ..error = failure is SuperTabFailure
              ? failure.message
              : 'Your message was not sent. Retry to check it.';
        onChanged();
        end(SwarmPostOutcome.lost);
      },
    );
    return outcome.future;
  }

  /// [onTaken], once for [post].
  void _taken(SwarmPost post) {
    if (post._told) return;
    post._told = true;
    onTaken(post);
  }

  /// A refusal that made no change: the backend said no for good.
  static bool refusal(SuperTabFailure failure) {
    final status = failure.statusCode;
    return status >= 400 && status < 500 && status != 408 && status != 429;
  }

  /// The posts that [messages] hold leave, whatever their state: the
  /// backend's copy shows in their place, once. True when one left.
  bool settle(Iterable<SuperTabMessage> messages) {
    if (_posts.isEmpty) return false;
    final ids = {for (final m in messages) m.id};
    var left = false;
    _posts.removeWhere((post) {
      if (!ids.contains(post.messageId)) return false;
      post
        .._arrived = true
        .._timer?.cancel();
      left = true;
      return true;
    });
    return left;
  }

  /// Every post goes, and no answer is waited on: access lost, chat left.
  void clear() {
    for (final post in _posts) {
      post._timer?.cancel();
    }
    _posts.clear();
  }

  void close() {
    clear();
    _closed = true;
  }

  /// The message id in a send's answer (`{result: {messageId}}`).
  static String? _idOf(Object? answer) {
    if (answer is! Map) return null;
    final result = answer['result'];
    if (result is! Map) return null;
    final id = result['messageId'];
    return id is String && id.isNotEmpty ? id : null;
  }
}
