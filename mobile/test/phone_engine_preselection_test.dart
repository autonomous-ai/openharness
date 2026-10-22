import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'phone_edge/edge_fixture.dart';

void main() {
  tearDown(() => newAgentDraft = null);
  for (final scenario in <(String, List<Map<String, Object>>, String)>[
    ('nothing signed in', [], 'OpenCode'),
    (
      'Claude only',
      [
        {'engine': 'claude', 'installed': true, 'signedIn': true},
      ],
      'Claude Code',
    ),
    (
      'Codex only',
      [
        {'engine': 'codex', 'installed': true, 'signedIn': true},
      ],
      'Codex',
    ),
    (
      'both, Claude last',
      [
        {
          'engine': 'claude',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 200,
        },
        {
          'engine': 'codex',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 100,
        },
      ],
      'Claude Code',
    ),
    (
      'both, Codex last',
      [
        {
          'engine': 'claude',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 100,
        },
        {
          'engine': 'codex',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 200,
        },
      ],
      'Codex',
    ),
    (
      'installed but signed out',
      [
        {'engine': 'claude', 'installed': true, 'signedIn': false},
        {'engine': 'codex', 'installed': true, 'signedIn': false},
      ],
      'OpenCode',
    ),
    (
      'old computer does not report sign-in',
      [
        {'engine': 'claude', 'installed': true},
      ],
      'OpenCode',
    ),
    (
      'credential without installed engine',
      [
        {'engine': 'codex', 'installed': false, 'signedIn': true},
      ],
      'OpenCode',
    ),
  ]) {
    testWidgets('computer chooses ${scenario.$1}', (tester) async {
      final app = edgeApp(
        conn: EdgeConn({
          'engines_probe': {'engines': scenario.$2},
        }, startsAgents),
      );
      addTearDown(app.dispose);
      await app.agentPreference.select(
        scenario.$3 == 'Claude Code' ? 'codex' : 'claude',
      );
      setPhone(tester, largePhone);
      await tester.pumpWidget(
        phoneApp(NewAgentPage(notifier: app, machineId: 'm')),
      );
      await frames(tester);
      final row = tester.widget<TtyFormRow>(
        find.byWidgetPredicate((w) => w is TtyFormRow && w.label == 'agent'),
      );
      expect(row.value, scenario.$3);
      await tester.pumpWidget(const SizedBox());
    });
  }
  testWidgets(
    'agent chooser retains Desktop catalog order after the selected agent',
    (tester) async {
      final source = File('../desktop/lib/widgets/engine_identity.dart')
          .readAsStringSync();
      final desktop = RegExp(r"^  '([^']+)': EngineIdentity", multiLine: true)
          .allMatches(source)
          .map((m) => m[1]!)
          .where((id) => allEngines.any((e) => e.id == id))
          .toList();
      expect(allEngines.map((e) => e.id).toList(), desktop);
      final app = edgeApp(
        conn: EdgeConn({
          'engines_probe': {'engines': []},
        }, startsAgents),
      );
      addTearDown(app.dispose);
      setPhone(tester, largePhone);
      await tester.pumpWidget(
        phoneApp(NewAgentPage(notifier: app, machineId: 'm')),
      );
      await frames(tester);
      await tester.tap(find.text('agent'));
      await frames(tester);
      // Desktop puts the selected agent first, then recents, then declaration order.
      expect(
        tester.getTopLeft(find.text('OpenCode', findRichText: true).last).dy,
        lessThan(
          tester
              .getTopLeft(find.text('Claude Code', findRichText: true).last)
              .dy,
        ),
      );
      expect(
        tester.getTopLeft(find.text('Cursor', findRichText: true).last).dy,
        lessThan(
          tester.getTopLeft(find.text('Amp', findRichText: true).last).dy,
        ),
      );
    },
  );
}
