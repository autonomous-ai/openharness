import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'phone_edge/edge_fixture.dart';

/// What a computer reports about an engine: installed, and — from a computer that says — signed in.
Map<String, Object> _engine(
  String id, {
  bool installed = true,
  bool? signedIn,
  int? lastUsedAt,
}) => {
  'engine': id,
  'installed': installed,
  'signedIn': ?signedIn,
  'lastUsedAt': ?lastUsedAt,
};

/// One computer's answer, the agent last started from the phone (if any), and what New Harness
/// should open on.
class _Case {
  const _Case(this.name, this.engines, this.opensOn, {this.remembered});
  final String name;
  final List<Map<String, Object>> engines;
  final String opensOn;
  final String? remembered;
}

void main() {
  tearDown(() => newAgentDraft = null);

  Future<AppNotifier> openForm(
    WidgetTester tester,
    List<Map<String, Object>> engines, {
    String? remembered,
  }) async {
    final app = edgeApp(
      conn: EdgeConn({
        'engines_probe': {'engines': engines},
      }, startsAgents),
    );
    addTearDown(app.dispose);
    if (remembered != null) await app.agentPreference.select(remembered);
    setPhone(tester, largePhone);
    await tester.pumpWidget(
      phoneApp(NewAgentPage(notifier: app, machineId: 'm')),
    );
    await frames(tester);
    return app;
  }

  String agentRow(WidgetTester tester) => tester
      .widget<TtyFormRow>(
        find.byWidgetPredicate((w) => w is TtyFormRow && w.label == 'agent'),
      )
      .value;

  Future<void> chooseAgent(WidgetTester tester, String title) async {
    await tapInView(tester, find.text('agent'));
    await frames(tester);
    await tester.tap(find.text(title, findRichText: true).last);
    await frames(tester);
  }

  for (final scenario in <_Case>[
    const _Case('nothing signed in', [], 'OpenCode'),
    _Case('Claude only', [_engine('claude', signedIn: true)], 'Claude Code'),
    _Case('Codex only', [_engine('codex', signedIn: true)], 'Codex'),
    _Case('both, Claude last', [
      _engine('claude', signedIn: true, lastUsedAt: 200),
      _engine('codex', signedIn: true, lastUsedAt: 100),
    ], 'Claude Code'),
    _Case('both, Codex last', [
      _engine('claude', signedIn: true, lastUsedAt: 100),
      _engine('codex', signedIn: true, lastUsedAt: 200),
    ], 'Codex'),
    _Case('installed but signed out', [
      _engine('claude', signedIn: false),
      _engine('codex', signedIn: false),
    ], 'OpenCode'),
    _Case('old computer does not report sign-in', [
      _engine('claude'),
    ], 'OpenCode'),
    _Case('credential without installed engine', [
      _engine('codex', installed: false, signedIn: true),
    ], 'OpenCode'),
    // The agent last started from this phone, as the desktop's `agentPreference`: kept while the
    // computer can still run it, else the computer's own answer.
    _Case(
      'remembered Codex is usable: it wins over Claude used last',
      [
        _engine('claude', signedIn: true, lastUsedAt: 200),
        _engine('codex', signedIn: true, lastUsedAt: 100),
      ],
      'Codex',
      remembered: 'codex',
    ),
    _Case(
      'remembered Codex is signed out here: the computer chooses',
      [_engine('claude', signedIn: true), _engine('codex', signedIn: false)],
      'Claude Code',
      remembered: 'codex',
    ),
    _Case(
      'remembered Codex is not installed here: the computer chooses',
      [
        _engine('claude', signedIn: true),
        _engine('codex', installed: false, signedIn: true),
      ],
      'Claude Code',
      remembered: 'codex',
    ),
    _Case(
      'remembered Claude on an older computer that reports no sign-in',
      [_engine('claude')],
      'Claude Code',
      remembered: 'claude',
    ),
    _Case(
      'remembered Claude that the computer says nothing about',
      [],
      'OpenCode',
      remembered: 'claude',
    ),
    _Case(
      'remembered OpenCode is kept over a signed-in Claude',
      [_engine('claude', signedIn: true), _engine('opencode')],
      'OpenCode',
      remembered: 'opencode',
    ),
  ]) {
    testWidgets('computer chooses ${scenario.name}', (tester) async {
      await openForm(tester, scenario.engines, remembered: scenario.remembered);
      expect(agentRow(tester), scenario.opensOn);
      await tester.pumpWidget(const SizedBox());
    });
  }

  // A pick is never undone: not by the computer's engines arriving, nor by a later probe.
  for (final scenario in <_Case>[
    _Case('signed out here', [
      _engine('claude', signedIn: false),
      _engine('codex', signedIn: true),
    ], 'Codex'),
    _Case('an older computer that reports no sign-in', [
      _engine('claude'),
    ], 'OpenCode'),
  ]) {
    testWidgets('a picked Claude Code is kept on ${scenario.name}', (
      tester,
    ) async {
      final app = await openForm(tester, scenario.engines);
      expect(agentRow(tester), scenario.opensOn);
      await chooseAgent(tester, 'Claude Code');
      expect(agentRow(tester), 'Claude Code');
      await app.probeEngines('m', force: true);
      await frames(tester);
      expect(agentRow(tester), 'Claude Code');
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
