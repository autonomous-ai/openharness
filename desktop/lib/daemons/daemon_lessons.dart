/// The paired daemon's lessons (`daemons/LEARNING.md`, BRAIN.md "Learning
/// (L1, L2) as built"), as the panel lists them: pending and approved, with
/// show, skip and revert through the same local `pair` request `harness pair
/// lessons ...` uses (`pair/control.ts` `lessons { action, id? }`).
///
/// A viewer can request a review capability for one pending lesson. Approval
/// uses the same person-only `daemon_act` path after this window has displayed
/// the complete lesson; its own `confirmed` never grants approval.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'daemon_brain.dart';

@immutable
class DaemonLesson {
  const DaemonLesson({
    required this.id,
    required this.name,
    this.kind = 'skill',
    this.status = 'pending',
    this.description = '',
    this.learnedBy = '',
    this.signal = '',
    this.project,
    this.approved,
    this.from = const [],
    this.reason = '',
    this.evidence = const [],
    this.sources = const [],
  });
  final String id, name, kind, status, description, learnedBy, signal;
  final String? project, approved;

  /// `codex@office turn 12`, one per turn it came from.
  final List<String> from;
  final String reason;
  final List<String> evidence;
  final List<DaemonLessonSource> sources;

  bool get pending => status == 'pending';
  bool get approvedNow => status == 'approved';

  /// `skill "run-migrations-safely"` or `note for api`.
  String get title => kind == 'note'
      ? 'note${project == null ? '' : ' for $project'}'
      : '"$name"';

  static DaemonLesson? fromJson(Object? raw) {
    if (raw is! Map || raw['id'] is! String || raw['name'] is! String) {
      return null;
    }
    String str(String key) => raw[key] is String ? raw[key] as String : '';
    return DaemonLesson(
      id: raw['id'] as String,
      name: raw['name'] as String,
      kind: str('kind').isEmpty ? 'skill' : str('kind'),
      status: str('status').isEmpty ? 'pending' : str('status'),
      description: str('description'),
      learnedBy: str('learnedBy'),
      signal: str('signal'),
      project: raw['project'] is String ? raw['project'] as String : null,
      approved: raw['approved'] is String ? raw['approved'] as String : null,
      from: [
        for (final f in raw['from'] is List ? raw['from'] as List : const [])
          if (f is String) f,
      ],
      reason: str('reason'),
      evidence: [
        for (final e
            in raw['evidence'] is List ? raw['evidence'] as List : const [])
          if (e is String) e,
      ],
      sources: [
        for (final s
            in raw['sources'] is List ? raw['sources'] as List : const [])
          if (s is Map) DaemonLessonSource.fromJson(s),
      ],
    );
  }
}

@immutable
class DaemonLessonSource {
  const DaemonLessonSource(this.title, this.engine, this.turn, this.at);
  final String title, engine;
  final int turn;
  final DateTime? at;
  factory DaemonLessonSource.fromJson(Map raw) => DaemonLessonSource(
    raw['title'] is String ? raw['title'] as String : '',
    raw['engine'] is String ? raw['engine'] as String : 'Agent',
    raw['turn'] is int ? raw['turn'] as int : 0,
    raw['at'] is num
        ? DateTime.fromMillisecondsSinceEpoch((raw['at'] as num).toInt())
              .toLocal()
        : null,
  );
}

@immutable
class DaemonHistoryReview {
  const DaemonHistoryReview({
    required this.state,
    this.total = 0,
    this.reviewed = 0,
    this.proposed = 0,
    this.hours = 24,
    this.more = false,
    this.indexing = 0,
    this.error,
  });
  final String state;
  final int total, reviewed, proposed, hours, indexing;
  final bool more;
  final String? error;
  bool get active => const ['queued', 'reviewing', 'waiting'].contains(state);
  bool get canRetry =>
      state == 'failed' || (state == 'waiting' && error == 'usage-limit');
  static DaemonHistoryReview? fromJson(Object? raw) {
    if (raw is! Map || raw['state'] is! String) return null;
    int n(String key, [int fallback = 0]) =>
        raw[key] is int ? raw[key] as int : fallback;
    return DaemonHistoryReview(
      state: raw['state'] as String,
      total: n('total'),
      reviewed: n('reviewed'),
      proposed: n('proposed'),
      hours: n('hours', 24),
      more: raw['more'] == true,
      indexing: n('indexing'),
      error: raw['error'] is String ? raw['error'] as String : null,
    );
  }

  String get title => switch (state) {
    'complete' => 'A look back, complete',
    'cancelled' => 'Your review is stopped',
    'failed' => 'Your review needs another try',
    'waiting' =>
      error == 'cap' ? 'Taking a little pause' : 'Your review is waiting',
    _ => 'Looking back over $hours hours',
  };
  String get detail {
    if (state == 'waiting' && error == 'no-model') {
      return 'Open your companion’s agent on the right. The review will use the model you choose there.';
    }
    if (state == 'waiting' && error == 'cap') {
      return '$reviewed of $total conversation turns reviewed. The rest will continue when the hourly review allowance resets.';
    }
    if (state == 'waiting' && error == 'usage-limit') {
      return 'Your chosen agent has reached its usage limit. Your conversations stay queued. Choose another agent above or retry later.';
    }
    if (state == 'failed') {
      return 'The review could not finish. Your progress and any proposed lessons are kept. Retry to continue.';
    }
    if (state == 'cancelled') {
      return 'Any lessons already proposed are still here for you to review.';
    }
    if (state == 'complete' && total == 0) {
      return 'No new dated conversation turns were found in this window. Previously reviewed turns are skipped.';
    }
    return '$reviewed of $total conversation turns reviewed · $proposed ${proposed == 1 ? 'lesson' : 'lessons'} proposed.';
  }
}

@immutable
class DaemonLearning {
  const DaemonLearning({
    required this.state,
    this.model,
    this.effort,
    this.queued = 0,
    this.pending = 0,
    this.lastOutcome,
    this.history,
  });
  final String state;
  final String? model, effort, lastOutcome;
  final int queued, pending;
  final DaemonHistoryReview? history;

  static DaemonLearning? fromJson(Object? raw) {
    if (raw is! Map || raw['state'] is! String) return null;
    final review = raw['lastReview'];
    return DaemonLearning(
      state: raw['state'] as String,
      model: raw['model'] is String ? raw['model'] as String : null,
      effort: raw['effort'] is String ? raw['effort'] as String : null,
      queued: raw['queued'] is int ? raw['queued'] as int : 0,
      pending: raw['pending'] is int ? raw['pending'] as int : 0,
      lastOutcome: review is Map && review['outcome'] is String
          ? review['outcome'] as String
          : null,
      history: DaemonHistoryReview.fromJson(raw['history']),
    );
  }

  String get title {
    if (state != 'ready') {
      return switch (state) {
        'off' => 'Learning is paused',
        'unsupported' => 'Learning is waiting for a supported connection',
        _ => 'Getting ready to learn',
      };
    }
    final name = switch (model) {
      'opus' => 'Opus',
      'sonnet' => 'Sonnet',
      'haiku' => 'Haiku',
      final String value => value,
      _ => 'your chosen model',
    };
    return 'Learning with $name';
  }

  String get detail {
    if (state == 'off') {
      return 'Learning resumes when your companion is turned on.';
    }
    if (state == 'unsupported') {
      return 'Background learning is not available with this connection yet. Your conversation and saved memories are kept.';
    }
    if (state == 'unopened') {
      return 'Open your companion with OpenCode, Codex, or Claude Code.';
    }
    if (state != 'ready') {
      return 'Finish setting up the agent on the right. Learning follows the model you choose there.';
    }
    if (pending > 0) {
      return 'A useful lesson is waiting for your approval. It will be shared with your agents once you approve it.';
    }
    if (lastOutcome == 'usage-limit') {
      return 'Your chosen model has reached its usage limit. Your observations are kept for a later review.';
    }
    if (['failed', 'timeout', 'no-model'].contains(lastOutcome)) {
      return 'The last review could not finish. Your observations are queued for another try.';
    }
    if (queued > 0) {
      return '$queued ${queued == 1 ? 'observation is' : 'observations are'} waiting for a quiet moment to review.';
    }
    if (lastOutcome == 'nothing' || lastOutcome == 'no-template') {
      return 'The last review found nothing worth saving yet. I’m watching for useful corrections and patterns in your work.';
    }
    return 'Watching for useful corrections and patterns in your work. Lessons are saved after you approve them.';
  }
}

class DaemonLessons extends ChangeNotifier {
  DaemonLessons(this.brain) {
    _results = brain.results.listen(_heard);
  }
  final DaemonBrain brain;
  late final StreamSubscription<DaemonActResult> _results;

  /// What approves [id] from a terminal, for a lesson not proposed now.
  static String approveCommand(String id) => 'harness pair lessons approve $id';

  List<DaemonLesson> _lessons = const [];
  bool _loaded = false, _busy = false, _disposed = false;
  String? _message, _note;
  String? _shownId, _shownText;
  String? _reviewId;
  Timer? _reviewExpiry, _approvalTimeout;
  String? get reviewId => _reviewId;
  DaemonLearning? _learning;
  DaemonLearning? get learning => _learning;

  /// Pending first, then approved; skipped and reverted ones are history.
  List<DaemonLesson> get lessons => _lessons;
  bool get loaded => _loaded;
  bool get busy => _busy;

  /// What the last action said (`learned "x".`, or why it did not).
  String? get message => _message;

  /// The store's own note (no git: a plain journal, and it says so).
  String? get note => _note;

  /// The lesson being read, and its text.
  String? get shownId => _shownId;
  String? get shownText => _shownText;

  Future<Map<String, dynamic>> _ask(Map<String, dynamic> payload) async {
    _busy = true;
    _notify();
    final result = await brain.request('lessons', payload);
    _busy = false;
    return result;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  static String _words(Map<String, dynamic> result) {
    final detail = result['detail'];
    if (detail is String && detail.isNotEmpty) return detail;
    return switch (result['error']) {
      'UNSUPPORTED' => 'this harnessd does not keep lessons yet.',
      'UNREACHABLE' || 'TIMEOUT' => 'harnessd did not answer.',
      'NOT_FOUND' => 'that lesson is gone.',
      'NONCE_REQUIRED' || 'PERSON_ONLY' || 'UNVERIFIED' => 'only you approve a lesson: its [y] while it is proposed, or a terminal.',
      final String code => code.toLowerCase().replaceAll('_', ' '),
      _ => 'that did not go through.',
    };
  }

  /// Read the list again.
  Future<void> refresh() async {
    final result = await _ask({'action': 'list'});
    if (_disposed) return;
    _loaded = true;
    if (result['ok'] == true) {
      final all = [
        for (final raw
            in result['lessons'] is List ? result['lessons'] as List : const [])
          ?DaemonLesson.fromJson(raw),
      ];
      _lessons = [
        ...all.where((l) => l.pending),
        ...all.where((l) => l.approvedNow),
      ];
      _note = result['note'] is String ? result['note'] as String : null;
      _learning = DaemonLearning.fromJson(result['learning']);
      if (_reviewId != null &&
          !_lessons.any((l) => l.id == _shownId && l.pending)) {
        _closeReview();
      }
    } else {
      _message = _words(result);
    }
    _notify();
  }

  /// Show a lesson's text (a second show closes it).
  Future<void> show(String id) async {
    if (_shownId == id) {
      _closeReview();
      _notify();
      return;
    }
    _closeReview();
    final result = await _ask({'action': 'show', 'id': id});
    if (_disposed) return;
    if (result['ok'] == true && result['text'] is String) {
      _shownId = id;
      _shownText = result['text'] as String;
    } else {
      _message = _words(result);
    }
    _notify();
  }

  void _closeReview() {
    _reviewExpiry?.cancel();
    _reviewId = null;
    _shownId = null;
    _shownText = null;
  }

  Future<void> review(String id) async {
    _closeReview();
    final result = await _ask({'action': 'review', 'id': id});
    if (_disposed) return;
    if (result['ok'] == true &&
        result['text'] is String &&
        result['reviewId'] is String) {
      _shownId = id;
      _shownText = result['text'] as String;
      _reviewId = result['reviewId'] as String;
      _message = null;
      final ms = result['expiresInMs'] is int
          ? result['expiresInMs'] as int
          : 600000;
      _reviewExpiry = Timer(Duration(milliseconds: ms.clamp(1, 600000)), () {
        _reviewId = null;
        _message = 'Open this lesson again to approve it.';
        _notify();
      });
    } else {
      _message = _words(result);
    }
    _notify();
  }

  void approveReviewed() {
    final id = _reviewId;
    if (_busy || id == null || !brain.act(id, 'y')) return;
    _busy = true;
    _approvalTimeout?.cancel();
    _approvalTimeout = Timer(const Duration(seconds: 20), () {
      _busy = false;
      _closeReview();
      _message = 'The approval was not confirmed. Refresh memories to check its result.';
      _notify();
    });
    _notify();
  }

  Future<void> reviewRecent() async {
    final result = await _ask({'action': 'review_recent', 'hours': 24});
    if (_disposed) return;
    _message = result['ok'] == true
        ? 'Your review of the last 24 hours is queued. Lessons will appear here for your approval.'
        : _words(result);
    await refresh();
  }

  Future<void> cancelReview() async {
    final result = await _ask({'action': 'cancel_review'});
    if (_disposed) return;
    _message = result['ok'] == true
        ? 'Review stopped. Proposed lessons are kept.'
        : _words(result);
    await refresh();
  }

  /// A key on a lesson's line (from the status line, the brief or the
  /// panel) taught or skipped it: say so, and read the list again.
  void _heard(DaemonActResult result) {
    if (_disposed || !result.id.startsWith('lesson:')) return;
    if (result.id == _reviewId) {
      _approvalTimeout?.cancel();
      _busy = false;
      if (!result.ok) {
        _message =
            result.detail ?? 'That review expired. Open the lesson again.';
        _closeReview();
        _notify();
        return;
      }
    }
    if (!result.ok) return;
    final learned = result.learned, skipped = result.skipped;
    if (learned == null && skipped == null) return;
    _message = learned != null
        ? 'learned "$learned". every harness will load it.'
        : 'skipped "$skipped". it will not come back.';
    _closeReview();
    unawaited(refresh());
  }

  Future<void> skip(String id) => _act('skip', id);

  /// `harness pair lessons revert`: one git revert, and every agent forgets
  /// it. Not the person's-only kind: a window may ask.
  Future<void> revert(String id) => _act('revert', id);

  Future<void> _act(String action, String id) async {
    final result = await _ask({'action': action, 'id': id});
    if (_disposed) return;
    final name = _lessons.where((l) => l.id == id).firstOrNull?.name ?? id;
    _message = result['ok'] == true
        ? switch (action) {
            'skip' => 'skipped "$name". it will not come back.',
            'revert' => 'took "$name" back. every agent forgets it.',
            _ => null,
          }
        : _words(result);
    if (_shownId == id) {
      _closeReview();
    }
    await refresh();
  }

  @override
  void dispose() {
    _disposed = true;
    _reviewExpiry?.cancel();
    _approvalTimeout?.cancel();
    unawaited(_results.cancel());
    super.dispose();
  }
}
