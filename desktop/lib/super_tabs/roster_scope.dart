import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'leaderboard/model.dart';
import 'model.dart';

/// Which people and agents the right pane lists (Dee, 2026-11-02): the whole
/// Swarm, as before, or only the project open in the chat.
enum SuperTabRosterScope { all, project }

/// The scope as Members' heading names it (Quiet Swarm, Dee, 2026-11-02).
String superTabRosterScopeLabel(SuperTabRosterScope scope) => switch (scope) {
  SuperTabRosterScope.project => 'This project',
  SuperTabRosterScope.all => 'All projects',
};

/// The roster's scope choice, kept per account and Swarm on this computer.
///
/// It stores only the choice, never a project's id, name or members: the
/// project it applies to is always the one open now, read from the controller's
/// own snapshot, so a project the reader can no longer read is simply not
/// there and the list falls back to the whole Swarm.
class SuperTabRosterScopeChoice extends ChangeNotifier {
  SuperTabRosterScopeChoice({
    required this.storage,
    required this.accountId,
    required this.tabId,
  }) {
    unawaited(_restore());
  }

  final LocalKeyValueStore? storage;
  final String accountId, tabId;

  /// What `swarmKeyAccount` sweeps with the account's other keys at sign-out.
  static String keyFor(String accountId, String tabId) =>
      'super_tab.scope.$accountId.$tabId';

  SuperTabRosterScope _scope = SuperTabRosterScope.all;
  int _edit = 0;
  Future<void> _writing = Future.value();
  bool _disposed = false;

  SuperTabRosterScope get scope => _scope;

  Future<void> _restore() async {
    final edit = ++_edit, store = storage;
    if (store == null) return;
    try {
      final raw = await store.read(keyFor(accountId, tabId));
      // A choice made while this read was out wins; so does a disposal.
      if (_disposed || edit != _edit) return;
      final scope = SuperTabRosterScope.values.asNameMap()[raw];
      if (scope == null || scope == _scope) return;
      _scope = scope;
      notifyListeners();
    } catch (_) {
      // An unreadable preference leaves the whole Swarm, the default.
    }
  }

  void choose(SuperTabRosterScope scope) {
    if (_disposed || scope == _scope) return;
    _edit++;
    _scope = scope;
    notifyListeners();
    final store = storage;
    if (store == null) return;
    final key = keyFor(accountId, tabId), value = scope.name;
    _writing = _writing
        .then((_) => store.write(key, value))
        .catchError((Object _) {});
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Whether [personId] belongs to [project] as far as this reader can tell.
/// The open project's board names exactly the people who can read it; before
/// that board lands, or when it failed, a private project is its owner and
/// invited members, and a public one is everyone in the Swarm.
bool personInProject(
  SuperTabProject project,
  String personId, {
  SuperTabLeaderboard? board,
}) {
  if (board != null && board.projectId == project.id) {
    return board.people.any((score) => score.personId == personId);
  }
  if (!project.isPrivate) return true;
  return project.ownerId == personId || project.memberIds.contains(personId);
}
