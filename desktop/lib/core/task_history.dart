import 'dart:convert';

import 'local_key_value_store.dart';

/// What the person has said to ⌘B, newest first: the box's recent prompts, as a search box keeps its
/// recent searches. Picking one says it again, decided on what the desk looks like now. Saved when it is
/// submitted, so one that could not be sent is there to try again. Kept on this computer, in the app's
/// state file, like the recent projects (`ProjectHistory`) — and only for the account that said them:
/// another account signing in on this Mac sees none of them, as it takes none of another's tabs
/// (`PaneLayoutStore.restorableFor`).
class TaskHistory {
  TaskHistory(this._storage);

  final LocalKeyValueStore? _storage;
  static const _key = 'task_box_recent_v1';

  /// How many are kept; the box shows fewer.
  static const keep = 20;

  /// Longer than this is a pasted document, not a prompt worth offering again.
  static const maxChars = 2000;

  String? _owner;
  final _recent = <String>[];
  Future<void>? _loading;
  Future<void> _saving = Future.value();
  int _revision = 0;

  /// The prompts [account] said; none for an account that is not known, or not theirs.
  List<String> recentFor(String? account) =>
      account != null && account == _owner
      ? List.unmodifiable(_recent)
      : const [];

  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    final revision = _revision;
    try {
      final raw = await _storage?.read(_key);
      if (raw == null || _revision != revision) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map ||
          decoded['owner'] is! String ||
          decoded['prompts'] is! List) {
        return;
      }
      _owner = decoded['owner'] as String;
      _recent
        ..clear()
        ..addAll(
          (decoded['prompts'] as List)
              .whereType<String>()
              .map((prompt) => prompt.trim())
              .where(_valid)
              .toSet()
              .take(keep),
        );
    } catch (_) {
      // A missing or unreadable history is no history: the box still works.
    }
  }

  static bool _valid(String prompt) =>
      prompt.isNotEmpty && prompt.length <= maxChars;

  /// [prompt] said again moves to the top rather than appearing twice. Said by an account that is not
  /// the one on record, it starts that account's history over; by none known, it is not kept.
  Future<void> add(String prompt, {required String? account}) async {
    final text = prompt.trim();
    if (account == null || !_valid(text)) return;
    await load();
    _revision++;
    if (_owner != account) {
      _owner = account;
      _recent.clear();
    }
    final rest = _recent.where((said) => said != text).take(keep - 1).toList();
    _recent
      ..clear()
      ..add(text)
      ..addAll(rest);
    final snapshot = jsonEncode({'owner': account, 'prompts': _recent});
    _saving = _saving.then((_) async {
      try {
        await _storage?.write(_key, snapshot);
      } catch (_) {}
    });
    await _saving;
  }
}
