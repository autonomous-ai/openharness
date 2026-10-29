import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/routing_policy.dart';
import 'package:harness/super_tabs/routing_policy_form.dart';
import 'package:harness/super_tabs/route_row.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

final json = {
  'version': 1,
  'floor': {'low': 1, 'medium': 2, 'high': 3},
  'quotaReserve': 10,
  'notes': '',
  'models': [
    {
      'engine': 'claude',
      'model': 'opus',
      'effort': 'high',
      'quality': 3,
      'cost': 3,
      'enabled': true,
    },
    {
      'engine': 'codex',
      'model': 'default',
      'effort': 'default',
      'quality': 3,
      'cost': 2,
      'enabled': true,
    },
  ],
};

Widget formOf(Widget form) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: form)),
);

void main() {
  test('round-trips the backend policy', () {
    expect(RoutingPolicy.fromJson(json).toJson(), json);
    // How local models count is not edited here, but an edit elsewhere keeps it.
    final local = {
      ...json,
      'localModels': {'quality': 2, 'enabled': false},
    };
    expect(RoutingPolicy.fromJson(local).copyWith(notes: 'x').toJson(), {
      ...local,
      'notes': 'x',
    });
  });

  test(
    'keeps the owner\'s benchmark prior overrides through an edit and a save',
    () {
      // Not edited here, but a Desktop save must not erase them (backend routingPolicy.ts priorOverrides).
      final overrides = [
        {'model': 'kimi k3', 'kind': 'cli', 'quality': 3},
      ];
      final withOverrides = {...json, 'priorOverrides': overrides};
      final parsed = RoutingPolicy.fromJson(withOverrides);
      expect(parsed.toJson(), withOverrides);
      expect(parsed.copyWith(notes: 'x').toJson(), {
        ...withOverrides,
        'notes': 'x',
      });
      // A policy saved without them stays without them.
      expect(
        RoutingPolicy.fromJson(json)
            .copyWith(notes: 'x')
            .toJson()
            .containsKey('priorOverrides'),
        isFalse,
      );
    },
  );

  testWidgets('edits a model, the floor, the reserve and the notes', (
    tester,
  ) async {
    RoutingPolicy? changed;
    await tester.pumpWidget(
      formOf(
        RoutingPolicyForm(
          value: RoutingPolicy.fromJson(json),
          onChanged: (v) => changed = v,
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('routing-model-enabled-1')));
    await tester.pump();
    expect(changed!.models[1].enabled, isFalse);
    await tester.enterText(find.byKey(const ValueKey('routing-reserve')), '25');
    await tester.pump();
    expect(changed!.quotaReserve, 25);
    await tester.enterText(
      find.byKey(const ValueKey('routing-notes')),
      'Frontend prefers Claude.',
    );
    await tester.pump();
    expect(changed!.notes, 'Frontend prefers Claude.');
  });

  testWidgets('a value the backend would reject is flagged, not accepted', (
    tester,
  ) async {
    RoutingPolicy? changed;
    final valid = <bool>[];
    await tester.pumpWidget(
      formOf(
        RoutingPolicyForm(
          value: RoutingPolicy.fromJson(json),
          onChanged: (v) => changed = v,
          onValidChanged: valid.add,
        ),
      ),
    );
    await tester.enterText(find.byKey(const ValueKey('routing-reserve')), '95');
    await tester.pump();
    expect(changed, isNull);
    expect(valid, [false]);
    expect(find.text('Enter a number from 0 to 90.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('routing-reserve')), '90');
    await tester.pump();
    expect(changed!.quotaReserve, 90);
    expect(valid, [false, true]);
    expect(find.text('Enter a number from 0 to 90.'), findsNothing);
  });

  testWidgets(
    'override mode offers Use account default per field and read-only hides edits',
    (tester) async {
      final used = <String>[];
      await tester.pumpWidget(
        formOf(
          RoutingPolicyForm(
            value: RoutingPolicy.fromJson(json),
            onChanged: (_) {},
            overridden: const {'notes'},
            onUseDefault: used.add,
          ),
        ),
      );
      expect(find.text('Use account default'), findsOneWidget);
      await tester.tap(find.text('Use account default'));
      expect(used, ['notes']);
      await tester.pumpWidget(
        formOf(
          RoutingPolicyForm(
            value: RoutingPolicy.fromJson(json),
            onChanged: (_) {},
            readOnly: true,
          ),
        ),
      );
      expect(
        tester
            .widget<Switch>(
              find.byKey(const ValueKey('routing-model-enabled-0')),
            )
            .onChanged,
        isNull,
      );
    },
  );

  Map<String, dynamic> policyAnswer() => {
    'policy': json,
    'warnings': <dynamic>[],
    'overridden': <String>[],
    'override': null,
  };

  Widget opener(controller) => MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showSuperTabRouting(context, controller),
          child: const Text('Open routing'),
        ),
      ),
    ),
  );

  testWidgets('the owner saves an override with only the changed field', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routingPolicy = policyAnswer();
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    await tester.pumpWidget(opener(controller));
    await tester.tap(find.text('Open routing'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('routing-notes')),
      'Frontend prefers Claude.',
    );
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(f.connection.server.posts.last['command'], {
      'type': 'tab.routingPolicy',
      'policy': {'notes': 'Frontend prefers Claude.'},
    });
    expect(find.text('Routing for this Swarm'), findsNothing);
    f.app.superTabs.dispose();
  });

  testWidgets(
    'Use account default shows the account value, clears the field, and saves no override',
    (tester) async {
      final f = SuperTabLaunchFixture();
      final account = {...json, 'notes': 'Account notes.'};
      f.connection.server.routingPolicy = {
        ...policyAnswer(),
        'policy': {...json, 'notes': 'Tab notes.'},
        'account': account,
        'overridden': ['notes'],
      };
      final controller = await f.app.superTabs.open(tabId);
      await controller.refresh();
      await tester.pumpWidget(opener(controller));
      await tester.tap(find.text('Open routing'));
      await tester.pumpAndSettle();
      expect(find.text('Tab notes.'), findsOneWidget);
      await tester.ensureVisible(find.text('Use account default'));
      await tester.tap(find.text('Use account default'));
      await tester.pumpAndSettle();
      expect(find.text('Tab notes.'), findsNothing);
      expect(find.text('Account notes.'), findsOneWidget);
      expect(find.text('Use account default'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(f.connection.server.posts.last['command'], {
        'type': 'tab.routingPolicy',
        'policy': null,
      });
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'Use account default on a field with a bad number restores Save',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.connection.server.routingPolicy = {
        ...policyAnswer(),
        'policy': {...json, 'quotaReserve': 25},
        'account': {...json, 'quotaReserve': 10},
        'overridden': ['quotaReserve'],
      };
      final controller = await f.app.superTabs.open(tabId);
      await controller.refresh();
      await tester.pumpWidget(opener(controller));
      await tester.tap(find.text('Open routing'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('routing-reserve')),
        '95',
      );
      await tester.pump();
      expect(find.text('Enter a number from 0 to 90.'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
            .onPressed,
        isNull,
      );
      await tester.ensureVisible(find.text('Use account default'));
      await tester.tap(find.text('Use account default'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a number from 0 to 90.'), findsNothing);
      expect(find.text('10'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
            .onPressed,
        isNotNull,
      );
      f.app.superTabs.dispose();
    },
  );

  testWidgets('a refused save stays open and says why', (tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routingPolicy = policyAnswer();
    f.connection.server.refuse = {
      'code': 'OWNER_REQUIRED',
      'message': 'Only the owner can change routing.',
    };
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    await tester.pumpWidget(opener(controller));
    await tester.tap(find.text('Open routing'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('routing-notes')), 'x');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Routing for this Swarm'), findsOneWidget);
    expect(find.textContaining('Only the owner'), findsOneWidget);
    f.app.superTabs.dispose();
  });

  testWidgets('a viewer sees the effective policy and no Save', (tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.routingPolicy = policyAnswer();
    f.connection.server.state['ownerId'] = 'someone-else';
    (f.connection.server.state['people'] as List)[0]['role'] = 'viewer';
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    await tester.pumpWidget(opener(controller));
    await tester.tap(find.text('Open routing'));
    await tester.pumpAndSettle();
    expect(find.text('Claude opus high'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
    expect(find.text('Close'), findsOneWidget);
    f.app.superTabs.dispose();
  });
}
