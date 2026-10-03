import 'dart:async';

import 'package:flutter/foundation.dart';

/// How a harness is shared: its link's visibility, or private invitations.
enum HarnessShareAccess { public, private }

/// A shared harness as its owner sees it at a glance. Absent means not shared.
@immutable
class HarnessShare {
  const HarnessShare(this.access, {this.people = 0});

  final HarnessShareAccess access;

  /// Accounts invited by email. A public link needs none.
  final int people;

  String get label => switch (access) {
    HarnessShareAccess.public => 'Public',
    HarnessShareAccess.private when people > 0 => 'Private · $people',
    HarnessShareAccess.private => 'Private',
  };

  String get detail => switch (access) {
    HarnessShareAccess.public =>
      'Shared publicly: anyone with the link watches',
    HarnessShareAccess.private when people == 1 =>
      'Shared privately with 1 person',
    HarnessShareAccess.private when people > 1 =>
      'Shared privately with $people people',
    HarnessShareAccess.private => 'Shared privately: only invited accounts',
  };

  @override
  bool operator ==(Object other) =>
      other is HarnessShare && other.access == access && other.people == people;

  @override
  int get hashCode => Object.hash(access, people);
}

/// What a `harness_share_*` answer says about sharing — every action answers
/// with the same list (cli/src/sharing/owner.ts). Null means not shared.
HarnessShare? harnessShareFrom(Map<String, dynamic> response) {
  final link = response['link'];
  final visibility = link is Map ? link['visibility'] : null;
  final people = (response['shares'] as List?)?.length ?? 0;
  if (visibility == 'public') return HarnessShare(HarnessShareAccess.public);
  if (visibility == 'private' || people > 0) {
    return HarnessShare(HarnessShareAccess.private, people: people);
  }
  return null;
}

typedef HarnessShareKey = (String machineId, String agentId);

/// The owner's harnesses and how each is shared, for marking panes. Learnt
/// from every share answer (the Share dialog's included) and asked once per
/// harness a pane shows; the daemon pushes no share events.
class HarnessShareStatus extends ChangeNotifier {
  HarnessShareStatus(this._list);

  final Future<Map<String, dynamic>> Function(String machineId, String agentId)
  _list;

  final _shares = <HarnessShareKey, HarnessShare>{};
  final _asked = <HarnessShareKey>{};

  HarnessShare? of(String machineId, String agentId) =>
      _shares[(machineId, agentId)];

  /// Takes in a share answer for this harness.
  void record(String machineId, String agentId, Map<String, dynamic> response) {
    final key = (machineId, agentId);
    _asked.add(key);
    final next = harnessShareFrom(response);
    if (_shares[key] == next) return;
    if (next == null) {
      _shares.remove(key);
    } else {
      _shares[key] = next;
    }
    notifyListeners();
  }

  /// Asks once. A failed answer (an older CLI, no connection) is asked again
  /// the next time a pane shows this harness.
  void ensure(String machineId, String agentId) {
    final key = (machineId, agentId);
    if (!_asked.add(key)) return;
    unawaited(
      Future.sync(() => _list(machineId, agentId)).then<void>(
        (response) => record(machineId, agentId, response),
        onError: (Object _) => _asked.remove(key),
      ),
    );
  }

  void clear() {
    _asked.clear();
    if (_shares.isEmpty) return;
    _shares.clear();
    notifyListeners();
  }
}
