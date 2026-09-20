import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

enum CommandKind { open, command, send, create, search, watch }

enum CommandPhase { idle, resolving, choosing, searching, executing, done }

typedef CommandResolver = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> request,
  CancelToken cancelToken,
);

/// The callback and its arguments originate in the app, never in the model response.
class CommandBarAction {
  const CommandBarAction({
    required this.id,
    required this.kind,
    required this.title,
    required this.detail,
    this.context = '',
    this.version = '',
    this.isSession = false,
    this.automatic = false,
    this.perform,
  });
  final String id, title, detail, context, version;
  final CommandKind kind;
  final bool isSession, automatic;
  final Future<String?> Function(String prompt)? perform;

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind.name,
    'title': _clip(title, 160),
    'detail': _clip(detail, 400),
    'context': _clip(context, 700),
  };

  String get buttonLabel => switch (kind) {
    CommandKind.send => 'Send prompt',
    CommandKind.create => 'Set up harness',
    CommandKind.watch => 'Start watching',
    CommandKind.search => 'Find matches',
    CommandKind.open => 'Open',
    CommandKind.command => 'Run action',
  };
}

String _clip(String text, int limit) =>
    text.length <= limit ? text : '${text.substring(0, limit - 1)}…';

class CommandWatch {
  CommandWatch(this.prompt, this.scope);
  final String prompt;
  // A watch never expands to newly discovered sessions without a new user action.
  final Map<String, String> scope;
  String? fingerprint, error;
  List<CommandBarAction> matches = [];
  bool checking = false;
  CancelToken? cancel;
}

/// Owns cancellation, exact identity revalidation and bounded, session-local watches.
/// Keystrokes stay local; only submission or an explicitly started watch calls JEV.
class CommandBarController extends ChangeNotifier {
  CommandBarController({
    required this.catalog,
    required this.resolve,
    this.watchInterval = const Duration(minutes: 1),
  });

  final List<CommandBarAction> Function() catalog;
  final CommandResolver resolve;
  final Duration watchInterval;
  CommandPhase phase = CommandPhase.idle;
  String query = '', message = '';
  String? error;
  List<CommandBarAction> rows = [];
  int selected = 0;
  int? elapsedMs;
  bool semanticResults = false;
  final List<CommandWatch> watches = [];
  CancelToken? _cancel;
  Timer? _watchTimer;
  int _epoch = 0;
  bool _disposed = false;
  bool get busy =>
      phase == CommandPhase.resolving ||
      phase == CommandPhase.searching ||
      phase == CommandPhase.executing;
  int get watchMatches =>
      watches.fold(0, (count, watch) => count + watch.matches.length);

  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void edit(String value) {
    if (phase == CommandPhase.executing) return;
    _epoch++;
    _cancel?.cancel();
    query = value;
    error = null;
    elapsedMs = null;
    semanticResults = false;
    phase = CommandPhase.idle;
    message = '';
    selected = 0;
    final text = value.trim().toLowerCase();
    rows = text.isEmpty
        ? []
        : catalog()
              .where(
                (a) => '${a.title} ${a.detail}'.toLowerCase().contains(text),
              )
              .take(5)
              .toList();
    _publish();
  }

  void dismiss() => edit('');

  void move(int delta) {
    if (rows.isEmpty || busy) return;
    selected = (selected + delta).clamp(0, rows.length - 1);
    _publish();
  }

  /// Max 96 candidates and 32k characters, including JSON overhead; large rosters remain bounded.
  List<CommandBarAction> snapshot({bool sessionsOnly = false}) {
    final result = <CommandBarAction>[];
    var size = query.length + 100;
    for (final action in catalog()) {
      if (sessionsOnly && !action.isSession) continue;
      final bytes = jsonEncode(action.toJson()).length + 1;
      if (size + bytes > 32000 || result.length >= 96) break;
      result.add(action);
      size += bytes;
    }
    return result;
  }

  Future<void> submit(String value) async {
    if (phase == CommandPhase.executing) return;
    edit(value);
    if (query.trim().isEmpty) return;
    if (query.length > 2000) {
      error = 'Keep this command under 2,000 characters. You can give an agent a longer task in its pane.';
      _publish();
      return;
    }
    final epoch = _epoch;
    final actions = snapshot();
    final byId = {for (final action in actions) action.id: action};
    _cancel = CancelToken();
    phase = CommandPhase.resolving;
    message = 'Finding the right action…';
    rows = [];
    _publish();
    try {
      final response = await resolve({
        'mode': 'resolve',
        'prompt': query,
        'candidates': actions.map((a) => a.toJson()).toList(),
      }, _cancel!);
      if (!_current(epoch)) return;
      elapsedMs = response['elapsedMs'] is int
          ? response['elapsedMs'] as int
          : null;
      final id = response['selectedId'];
      if (id != null && (id is! String || !byId.containsKey(id))) {
        throw const FormatException();
      }
      final action = byId[id];
      final alternatives = response['suggestions'];
      rows = [
        ?action,
        if (alternatives is List)
          for (final id in alternatives.take(3))
            if (byId[id] != null && id != action?.id) byId[id]!,
      ];
      phase = CommandPhase.choosing;
      message = action == null
          ? 'No clear match. Try a more specific command or choose an action.'
          : 'Suggested action';
      if (action != null &&
          action.automatic &&
          response['autoExecute'] == true) {
        await choose(action);
      } else {
        _publish();
      }
    } catch (e) {
      if (!_current(epoch)) return;
      _failure(e);
    }
  }

  bool _current(int epoch) => !_disposed && epoch == _epoch;

  Future<void> choose(CommandBarAction action) async {
    if (_disposed || phase == CommandPhase.executing) return;
    final current = catalog()
        .where((a) => a.id == action.id && a.version == action.version)
        .firstOrNull;
    if (current == null) {
      error = 'That target changed or is no longer available. Run your command again.';
      phase = CommandPhase.choosing;
      _publish();
      return;
    }
    if (current.kind == CommandKind.search) {
      await find();
      return;
    }
    if (current.kind == CommandKind.watch) {
      await startWatch();
      return;
    }
    _epoch++;
    _cancel?.cancel();
    final epoch = _epoch;
    final prompt = query;
    phase = CommandPhase.executing;
    error = null;
    message = current.kind == CommandKind.send
        ? 'Sending to ${current.title}…'
        : 'Opening ${current.title}…';
    _publish();
    try {
      final failure = current.perform == null
          ? 'This action is not available.'
          : await current.perform!(prompt);
      if (!_current(epoch)) return;
      phase = CommandPhase.done;
      error = failure;
      message = failure == null
          ? switch (current.kind) {
              CommandKind.send => 'Sent to ${current.title}',
              CommandKind.create => 'Harness setup opened',
              _ => current.title,
            }
          : '';
      rows = [];
    } catch (_) {
      if (!_current(epoch)) return;
      phase = CommandPhase.done;
      error =
          'The action could not finish. Check the target before trying again.';
    }
    _publish();
  }

  Future<void> find() async {
    if (phase == CommandPhase.executing || query.trim().isEmpty) return;
    final actions = snapshot(sessionsOnly: true);
    final epoch = ++_epoch;
    _cancel?.cancel();
    _cancel = CancelToken();
    phase = CommandPhase.searching;
    error = null;
    rows = [];
    message = 'Looking through recent session activity…';
    _publish();
    try {
      final matches = await _match(query, actions, _cancel!);
      if (!_current(epoch)) return;
      rows = matches;
      semanticResults = true;
      selected = 0;
      phase = CommandPhase.choosing;
      message = rows.isEmpty
          ? 'No matches in the available recent activity.'
          : 'Matches in recent activity';
      _publish();
    } catch (e) {
      if (_current(epoch)) _failure(e);
    }
  }

  Future<List<CommandBarAction>> _match(
    String prompt,
    List<CommandBarAction> actions,
    CancelToken cancel,
  ) async {
    if (actions.isEmpty) return [];
    final response = await resolve({
      'mode': 'match',
      'prompt': prompt,
      'candidates': actions.map((a) => a.toJson()).toList(),
    }, cancel);
    final matches = response['matches'];
    if (matches is! List) throw const FormatException();
    final byId = {for (final action in actions) action.id: action};
    final result = <CommandBarAction>[];
    for (final raw in matches.take(12)) {
      if (raw is! Map || byId[raw['id']] == null) throw const FormatException();
      final action = byId[raw['id']]!;
      if (!result.contains(action)) result.add(action);
    }
    return result;
  }

  Future<void> startWatch() async {
    if (query.trim().isEmpty || busy) return;
    if (watches.length >= 2) {
      error = 'Two watches are already running. Stop one to add another.';
      _publish();
      return;
    }
    final scope = snapshot(sessionsOnly: true).take(24).toList();
    if (scope.isEmpty) {
      error = 'Open a session before starting a watch.';
      phase = CommandPhase.choosing;
      _publish();
      return;
    }
    final watch = CommandWatch(query, {for (final a in scope) a.id: a.version});
    watches.add(watch);
    rows = [];
    phase = CommandPhase.done;
    message =
        'Watching ${scope.length} current sessions while this window is open.';
    error = null;
    _watchTimer ??= Timer.periodic(watchInterval, (_) => checkWatches());
    _publish();
    await checkWatches();
  }

  /// One bounded evaluation per changed snapshot per minute. Errors pause a rule until resumed.
  Future<void> checkWatches() async {
    if (_disposed) return;
    for (final watch in List.of(watches)) {
      if (_disposed) break;
      if (!watches.contains(watch)) continue;
      if (watch.checking || watch.error != null) continue;
      final scope = catalog()
          .where((a) => a.isSession && watch.scope[a.id] == a.version)
          .toList();
      final fingerprint = jsonEncode(scope.map((a) => a.toJson()).toList());
      if (watch.fingerprint == fingerprint) continue;
      watch.fingerprint = fingerprint;
      watch.checking = true;
      watch.cancel = CancelToken();
      _publish();
      try {
        final matches = await _match(watch.prompt, scope, watch.cancel!);
        if (_disposed || !watches.contains(watch)) continue;
        watch.matches = matches;
      } catch (_) {
        if (!_disposed && watches.contains(watch)) {
          watch.error = 'Paused — JEV could not check this watch.';
        }
      } finally {
        watch.checking = false;
        _publish();
      }
    }
  }

  void stopWatch(CommandWatch watch) {
    watch.cancel?.cancel();
    watches.remove(watch);
    if (watches.isEmpty) {
      _watchTimer?.cancel();
      _watchTimer = null;
    }
    _publish();
  }

  void resumeWatch(CommandWatch watch) {
    watch.error = null;
    watch.fingerprint = null;
    unawaited(checkWatches());
  }

  void _failure(Object e) {
    phase = CommandPhase.choosing;
    error = e is ApiException ? e.message : 'JEV could not answer. Check the experiment daemon and OpenRouter connection, or choose a local action.';
    rows = catalog()
        .where((a) => a.kind == CommandKind.command)
        .take(5)
        .toList();
    message = 'Local actions';
    _publish();
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _cancel?.cancel();
    _watchTimer?.cancel();
    for (final watch in watches) {
      watch.cancel?.cancel();
    }
    super.dispose();
  }
}
