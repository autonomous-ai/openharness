import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_share_status.dart';
import 'package:harness/widgets/pane_share_badge.dart';

Map<String, dynamic> _answer({String? visibility, int people = 0}) => {
  'link': visibility == null ? null : {'id': 'l1', 'visibility': visibility},
  'shares': [
    for (var i = 0; i < people; i++) {'id': 's$i', 'email': 'p$i@x.io'},
  ],
  'collaboration': true,
};

void main() {
  group('harnessShareFrom', () {
    test('a public link reads Public, whoever was invited', () {
      // Share hides People while a link is public: invitations do not apply.
      expect(
        harnessShareFrom(_answer(visibility: 'public', people: 2)),
        const HarnessShare(HarnessShareAccess.public),
      );
    });

    test('a private link or invitations read Private, with the count', () {
      expect(
        harnessShareFrom(_answer(visibility: 'private'))?.label,
        'Private',
      );
      expect(harnessShareFrom(_answer(people: 3))?.label, 'Private · 3');
    });

    test('no link, a link turned off, and no invitations: not shared', () {
      expect(harnessShareFrom(_answer()), isNull);
      expect(harnessShareFrom(_answer(visibility: 'off')), isNull);
      expect(harnessShareFrom(const {'error': 'UNSUPPORTED'}), isNull);
    });
  });

  group('HarnessShareStatus', () {
    test('asks once per harness and keeps the answer', () async {
      var asks = 0;
      final status = HarnessShareStatus((_, _) async {
        asks++;
        return _answer(visibility: 'public');
      });
      status.ensure('m', 'a');
      status.ensure('m', 'a');
      await pumpEventQueue();
      expect(asks, 1);
      expect(status.of('m', 'a')?.access, HarnessShareAccess.public);
    });

    test('a failed ask is asked again next time', () async {
      var asks = 0;
      final status = HarnessShareStatus((_, _) {
        asks++;
        if (asks == 1) throw StateError('offline');
        return Future.value(_answer(people: 1));
      });
      status.ensure('m', 'a');
      await pumpEventQueue();
      expect(status.of('m', 'a'), isNull);
      status.ensure('m', 'a');
      await pumpEventQueue();
      expect(asks, 2);
      expect(status.of('m', 'a')?.label, 'Private · 1');
    });

    test('stopping sharing clears the mark, and only changes notify', () {
      final status = HarnessShareStatus((_, _) => Completer<Never>().future);
      var notified = 0;
      status.addListener(() => notified++);
      status.record('m', 'a', _answer(visibility: 'private'));
      status.record('m', 'a', _answer(visibility: 'private'));
      expect(notified, 1);
      status.record('m', 'a', _answer(visibility: 'off'));
      expect(status.of('m', 'a'), isNull);
      expect(notified, 2);
    });
  });

  testWidgets('the pane badge names the share and hides when there is none', (
    tester,
  ) async {
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession());
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PaneShareBadge(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            name: 'Weather',
          ),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('pane-share:m:a')), findsNothing);
    app.shareStatus.record('m', 'a', _answer(visibility: 'public'));
    await tester.pump();
    expect(find.text('Public'), findsOneWidget);
    app.shareStatus.record('m', 'a', _answer(visibility: 'private', people: 2));
    await tester.pump();
    expect(find.text('Private · 2'), findsOneWidget);
    app.shareStatus.record('m', 'a', _answer());
    await tester.pump();
    expect(find.byKey(const ValueKey('pane-share:m:a')), findsNothing);
  });
}
