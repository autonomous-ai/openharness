import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';

import 'support/model_manager.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _App extends ModelManagerTestApp {
  _App(super.connection);

  final store = MemoryStore();

  @override
  MemoryStore get localStore => store;
}

/// The join's Bring agent kept, per account on this computer, the Swarms it
/// was offered for (`swarm_join_seen.<account>`). It went with v3's Buddy
/// (2026-11-10): the record goes when its account signs in, another's stays.
void main() {
  test('signing in removes that account\'s join record, and only it', () async {
    final app = _App(ModelManagerConnection());
    addTearDown(app.dispose);
    app.store.values
      ..['swarm_join_seen.owner'] = '{"seen":["tab"]}'
      ..['swarm_join_seen.peer'] = '{"seen":["tab"]}';
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    await pumpEventQueue();
    expect(app.store.values.containsKey('swarm_join_seen.owner'), isFalse);
    expect(app.store.values['swarm_join_seen.peer'], '{"seen":["tab"]}');
  });
}
