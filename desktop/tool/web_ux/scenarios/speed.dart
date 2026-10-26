/// Scenarios for first load and connect speed.
///
/// Fix group: speed (first load and connect). Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'dart:async';

import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/web/onboarding/saved_computers.dart';

import '../../../test/support/web_ux_app.dart';
import '../../web_ux_seed.dart';
import 'scenario.dart';

const _account = 'jamie';

/// Signed in as an account with an id, which kept computers are keyed by.
WebUxApp _signedInWithId() => signedIn()
  ..currentUser = const CurrentUserProfile(
    id: _account,
    name: 'Jamie Rivera',
    email: webUxEmail,
  );

final Map<String, WebUxScenario> speedScenarios = {
  // A returning browser before the machine list answers: the computers it
  // kept from the last answer, each checking.
  'first-machine-saved': WebUxScenario(() {
    final kept = SavedComputers(HarnessFileStore.shared);
    unawaited(
      kept.claim(_account).then(
        (_) => kept.write(_account, const [
          SavedComputer(id: 'm1', name: 'Studio Mac'),
          SavedComputer(id: 'm2', name: 'Build server (ubuntu-24)'),
        ]),
      ),
    );
    return _signedInWithId()..inventoryLoaded = false;
  }),
  // A Finder tile beside its chat: the Finder is a part main.dart.js leaves out.
  'finder-part': WebUxScenario(() {
    final app = withPanes(signedIn(), 1);
    app.activeSwarm.panes.add(
      TerminalPane(
        id: 900,
        machineId: 'm1',
        kind: PaneKind.finder,
        finderRoot: '/Users/jamie/shop',
      ),
    );
    return app;
  }),
};
