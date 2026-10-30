import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/privacy_policy.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/welcome/how_it_works.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'edge_fixture.dart';

/// Settings as somebody goes through it: every row that opens something, opened and put away.
///
/// ⚠️ **No choice is made in any of them.** Each preference here writes through a store whose
/// default home is the real state file under `~/.harness` — a test that picked a font would write
/// to the developer's own. Opening a sheet reads; only a tap on one of its rows writes.
void main() {
  setUpAll(
    () => PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.2.3',
      buildNumber: '456',
      buildSignature: '',
    ),
  );

  Future<AppNotifier> openSettings(
    WidgetTester tester, {
    bool large = true,
    bool sample = false,
    CurrentUserProfile? user,
    ProductMeasurement? usage,
    ExperimentalFeaturesStore? experiments,
  }) async {
    setPhone(tester, largePhone);
    final app = edgeApp(productMeasurement: usage);
    app.currentUser =
        user ??
        const CurrentUserProfile(
          id: 'u',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
        );
    final page = SettingsPage(
      notifier: app,
      large: large,
      experiments: experiments,
    );
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => sample
                    ? SampleMode(session: FakeSample(app), child: page)
                    : page,
              ),
            ),
            child: const Text('focus'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('focus'));
    await frames(tester);
    return app;
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  /// Opens what [row] opens, checks [shows] is on screen, and puts it away with the barrier.
  Future<void> peek(WidgetTester tester, String row, String shows) async {
    await tapInView(tester, find.text(row));
    await frames(tester);
    expect(find.text(shows, findRichText: true), findsWidgets, reason: row);
    await tester.tapAt(const Offset(20, 80));
    await frames(tester);
  }

  testWidgets('the account, the sheets, the phone\'s name and the build', (
    tester,
  ) async {
    final app = await openSettings(tester);
    expect(find.text('A'), findsOneWidget, reason: 'the avatar\'s initial');

    await peek(tester, 'Ada Lovelace', 'Sign out');
    await tapInView(tester, find.text('Phone name'));
    await frames(tester);
    expect(find.text('Leave empty to use the name above.'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await frames(tester);
    await peek(tester, 'Font', 'Terminal font');
    await peek(tester, 'Colors', 'Terminal colors');
    await peek(tester, 'Language', 'Voice input language');
    await peek(tester, 'App colors', 'App colors');

    // At the foot: the version and the build, read from the bundle.
    await tester.scrollUntilVisible(
      find.text('456'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('1.2.3'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('as the You tab under another, it follows the app no more, and '
      'catches up once shown', (tester) async {
    setPhone(tester, largePhone);
    final app = edgeApp()
      ..currentUser = const CurrentUserProfile(
        id: 'u',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      );
    final hidden = ValueNotifier(false);
    addTearDown(hidden.dispose);
    await tester.pumpWidget(
      phoneApp(
        ValueListenableBuilder(
          valueListenable: hidden,
          builder: (_, isHidden, child) =>
              OutOfSight(hidden: isHidden, child: child!),
          child: SettingsPage(notifier: app),
        ),
      ),
    );
    await frames(tester);
    expect(find.text('Ada Lovelace'), findsOneWidget);

    hidden.value = true;
    await tester.pump();
    app
      ..currentUser = const CurrentUserProfile(
        id: 'u',
        name: 'Grace Hopper',
        email: 'grace@example.com',
      )
      ..notifyListeners();
    await tester.pump();

    expect(find.text('Ada Lovelace'), findsOneWidget, reason: 'as left');

    hidden.value = false;
    await tester.pump();

    expect(find.text('Grace Hopper'), findsOneWidget);
    await close(tester, app);
  });

  group('About ▸ Privacy Policy', () {
    /// The policy's opener, recording what it is asked to open and answering [opens].
    List<Uri> opening({Future<bool> Function()? opens}) {
      final asked = <Uri>[];
      final before = openPrivacyPolicyUrl;
      addTearDown(() => openPrivacyPolicyUrl = before);
      openPrivacyPolicyUrl = (url) {
        asked.add(url);
        return opens?.call() ?? Future.value(true);
      };
      return asked;
    }

    Future<void> tapPolicy(WidgetTester tester) async {
      await tapInView(tester, find.text('Privacy Policy'));
      await frames(tester);
    }

    // App Store 5.1.1(i): the policy reachable from inside the app, not only beside its listing.
    testWidgets('opens Autonomous\'s policy, the address every listing names', (
      tester,
    ) async {
      final asked = opening();
      final app = await openSettings(tester);

      await tapPolicy(tester);

      expect(asked, [Uri.parse('https://www.autonomous.ai/privacy')]);
      expect(find.text('Could not open the browser.'), findsNothing);
      await close(tester, app);
    });

    for (final (name, opens) in <(String, Future<bool> Function())>[
      ('declines', () => Future.value(false)),
      ('throws', () => Future<bool>.error(StateError('no browser'))),
    ]) {
      testWidgets('a browser that $name is said', (tester) async {
        opening(opens: opens);
        final app = await openSettings(tester);

        await tapPolicy(tester);

        expect(find.text('Could not open the browser.'), findsOneWidget);
        await close(tester, app);
      });
    }
  });

  testWidgets('Computers and How Harness works open their pages', (
    tester,
  ) async {
    final usage = RecordedOpenings();
    final app = await openSettings(tester, large: false, usage: usage);
    await tapInView(tester, find.text('Computers'));
    await frames(tester, count: 6);
    expect(find.byType(MachinesTab), findsOneWidget);
    expect(usage.opened, [(PhoneScreen.computers, ScreenOpening.button)]);
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);

    await tapInView(tester, find.text('How Harness works'));
    await frames(tester, count: 6);
    expect(find.byType(HowItWorksPage), findsOneWidget);
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);

    // Pushed from a terminal's menu: the back chevron is the way out.
    await tester.tap(find.bySemanticsLabel(RegExp('Back')).first);
    await frames(tester, count: 6);
    expect(find.byType(SettingsPage), findsNothing);
    await close(tester, app);
  });

  // ⚠️ The row promises what reaches a phone over the relay, and nothing else: a question does since
  // 2026-10-21 (`commander_question`, cli core/questions.ts `sendRemote`).
  testWidgets('Notifications: a harness finishing or needing you, a new device', (
    tester,
  ) async {
    final app = await openSettings(tester);
    final row = find.byKey(const ValueKey('settings-notifications'));
    if (row.evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        row,
        200,
        scrollable: find.byType(Scrollable).first,
      );
    }
    expect(
      find.descendant(
        of: row,
        matching: find.text(
          'When a harness finishes or needs you, or a new device joins your account.',
        ),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('needs you'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('an account whose name is only an email, or nothing at all', (
    tester,
  ) async {
    var app = await openSettings(
      tester,
      user: const CurrentUserProfile(id: 'u', email: 'zed@example.com'),
    );
    expect(find.text('Z'), findsOneWidget);
    await close(tester, app);

    app = await openSettings(
      tester,
      user: const CurrentUserProfile(id: 'u', name: '  ', email: ''),
    );
    expect(find.text('?'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets(
    'Experimental: Swarm is turned on from its page, and off at once',
    (tester) async {
      final storage = MemoryKeyValueStore();
      final experiments = ExperimentalFeaturesStore(storage: storage);
      final app = await openSettings(tester, experiments: experiments);
      final row = find.byKey(const ValueKey('settings-experiment-swarm'));
      await tester.scrollUntilVisible(
        row,
        200,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.text('experimental'), findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.text('Swarm')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row,
          matching: find.text(
            'Open your Swarms from Home or Find. Still taking shape.',
          ),
        ),
        findsOneWidget,
        reason: 'both ways in, as the app has them',
      );
      Switch toggle() => tester.widget<Switch>(
        find.descendant(of: row, matching: find.byType(Switch)),
      );
      expect(toggle().value, isFalse);

      // Anywhere on the row opens what Swarm does, with Not now and Turn on Swarm.
      await tester.tap(find.descendant(of: row, matching: find.text('Swarm')));
      await frames(tester, count: 8);
      expect(find.text('Your team of agents, on your phone'), findsOneWidget);
      expect(find.text('See what needs you'), findsOneWidget);
      expect(find.text('Answer in one tap'), findsOneWidget);
      expect(find.text('Brainstorm with your Buddy'), findsOneWidget);
      expect(find.text('Chat with your PM'), findsNothing);
      await tester.tap(find.text('Not now'));
      // A page's slide out takes longer than [frames]' default.
      await frames(tester, count: 8);
      expect(find.text('Your team of agents, on your phone'), findsNothing);
      expect(toggle().value, isFalse);
      expect(experiments.isOn(PhoneExperiment.swarm), isFalse);

      // The switch opens it too; Turn on Swarm turns it on, back in Settings, and the choice is
      // written for the next launch.
      await tester.tap(find.descendant(of: row, matching: find.byType(Switch)));
      await frames(tester, count: 8);
      expect(find.text('Your team of agents, on your phone'), findsOneWidget);
      await tester.tap(find.text('Turn on Swarm'));
      await frames(tester, count: 8);
      expect(find.text('Your team of agents, on your phone'), findsNothing);
      expect(toggle().value, isTrue);
      expect(experiments.isOn(PhoneExperiment.swarm), isTrue);
      expect(storage.values['experimental_features'], '["swarm"]');

      // The switch itself turns it off again.
      await tester.tap(find.descendant(of: row, matching: find.byType(Switch)));
      await frames(tester);
      expect(toggle().value, isFalse);
      expect(experiments.isOn(PhoneExperiment.swarm), isFalse);
      expect(storage.values['experimental_features'], '[]');
      await close(tester, app);
    },
  );

  testWidgets('inside the sample: the way out, and no sample to try', (
    tester,
  ) async {
    final app = await openSettings(tester, sample: true);
    expect(find.text('Try the sample'), findsNothing);
    expect(find.text('sample'), findsOneWidget);
    await tester.tap(find.text('Leave the sample'));
    await frames(tester);
    await close(tester, app);
  });
}
