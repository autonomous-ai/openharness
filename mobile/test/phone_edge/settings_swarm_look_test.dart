import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'edge_fixture.dart';

/// Settings opened from Swarm's You wears Swarm's pages (prototype A lean, 2026-11-03,
/// `docs/design/2026-11-03-swarm-settings.md`): Swarm's top bar, sentence-case captions, cards of
/// Swarm rows each led by a glyph, in the app's face; the account's rows in three cards; Swarm
/// with no line under it; Language in Terminal's card; Help and About one row each, opening a
/// sheet of what they held; no Notifications or Theme, which are on You (2026-11-04). Opened from
/// anywhere else, it keeps the phone's own look.
///
/// No choice is made in any sheet or stepper: those write through stores whose home is the real
/// state file (see `settings_behavior_test.dart`).
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
    required bool swarm,
    bool noMachines = false,
    bool sample = false,
  }) async {
    setPhone(tester, largePhone);
    final app = edgeApp(noMachines: noMachines)
      ..currentUser = const CurrentUserProfile(
        id: 'u',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      );
    final page = SettingsPage(
      notifier: app,
      large: false,
      swarm: swarm,
      experiments: ExperimentalFeaturesStore(storage: MemoryKeyValueStore()),
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
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await frames(tester);
    return app;
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  /// Scrolls the list until [finder] is built and on screen.
  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(
      finder,
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pump();
  }

  Finder rowOf(String title) =>
      find.ancestor(of: find.text(title), matching: find.byType(SwarmRow));
  Finder cardOf(String title) =>
      find.ancestor(of: find.text(title), matching: find.byType(SwarmGroup));
  Finder inCard(String card, String row) =>
      find.descendant(of: cardOf(card), matching: find.text(row));
  Finder captioned(String text) =>
      find.descendant(of: find.byType(SwarmCaption), matching: find.text(text));

  /// Taps where no sheet reaches, which takes the open one down.
  Future<void> dismissSheet(WidgetTester tester) async {
    await tester.tapAt(const Offset(20, 80));
    await frames(tester);
  }

  /// The face [text] is drawn in, after every default above it is merged in.
  String? faceOf(WidgetTester tester, String text) => tester
      .widget<RichText>(
        find
            .descendant(of: find.text(text), matching: find.byType(RichText))
            .first,
      )
      .text
      .style
      ?.fontFamily;

  String terminalFace(WidgetTester tester) =>
      Tty.of(tester.element(find.byType(SettingsPage))).fontFamily;

  group('opened from Swarm', () {
    testWidgets("Swarm's top bar: back and the title on one line, no "
        'display-size title under it', (tester) async {
      final app = await openSettings(tester, swarm: true);

      expect(
        find.descendant(
          of: find.byType(SettingsPage),
          matching: find.byType(SwarmTopBar),
        ),
        findsOneWidget,
      );
      expect(find.text('Settings'), findsOneWidget, reason: 'one title');

      await tester.tap(find.byKey(const ValueKey('tty-back')));
      await frames(tester, count: 8);
      expect(find.byType(SettingsPage), findsNothing);
      await close(tester, app);
    });

    testWidgets("Swarm's rows, in the app's face, each led by its glyph", (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true);

      // Top to bottom, as the list goes: it builds only what it shows.
      for (final (title, glyph) in [
        ('Usage', LucideIcons.gauge300),
        ('Privacy', LucideIcons.shield300),
        ('Computers', LucideIcons.laptop300),
        ('Connectors', LucideIcons.plug300),
        ('Sign in a computer', LucideIcons.qrCode300),
        ('Your devices', LucideIcons.monitorSmartphone300),
        ('Phone name', LucideIcons.smartphone300),
        ('Font', LucideIcons.type300),
        ('Size', LucideIcons.aLargeSmall300),
        ('Colors', LucideIcons.palette300),
        ('Language', LucideIcons.mic300),
        ('Text size', LucideIcons.aLargeSmall300),
        ('Swarm', LucideIcons.flaskConical300),
        ('Help', LucideIcons.circleHelp300),
        ('About', LucideIcons.info300),
      ]) {
        await reveal(tester, find.text(title));
        expect(rowOf(title), findsOneWidget, reason: title);
        expect(
          find.descendant(of: rowOf(title), matching: find.byIcon(glyph)),
          findsOneWidget,
          reason: '$title leads with its glyph',
        );
      }
      expect(
        faceOf(tester, 'About'),
        isNot(terminalFace(tester)),
        reason: "the app's face, not the terminal's",
      );
      await close(tester, app);
    });

    testWidgets('three captions, in sentence case, as Swarm writes them: '
        'no Voice, Help or About', (tester) async {
      final app = await openSettings(tester, swarm: true);

      for (final caption in ['Terminal', 'Appearance', 'Experimental']) {
        await reveal(tester, captioned(caption));
        expect(find.text(caption.toLowerCase()), findsNothing);
      }
      await reveal(tester, find.text('About'));
      expect(find.text('Voice'), findsNothing);
      expect(captioned('Help'), findsNothing, reason: 'a row, not a caption');
      expect(captioned('About'), findsNothing, reason: 'a row, not a caption');
      expect(find.text('Account'), findsNothing, reason: 'cards, no caption');
      expect(find.text('account'), findsNothing);
      await close(tester, app);
    });

    testWidgets("the account's rows stand in three cards: you and what you "
        'use, your computers, this phone', (tester) async {
      final app = await openSettings(tester, swarm: true);

      for (final row in ['Usage', 'Privacy']) {
        expect(inCard('Ada Lovelace', row), findsOneWidget, reason: row);
      }
      expect(inCard('Usage', 'Computers'), findsNothing);

      await reveal(tester, find.text('Sign in a computer'));
      for (final row in ['Connectors', 'Sign in a computer']) {
        expect(inCard('Computers', row), findsOneWidget, reason: row);
      }
      expect(inCard('Computers', 'Your devices'), findsNothing);

      await reveal(tester, find.text('Phone name'));
      expect(inCard('Your devices', 'Phone name'), findsOneWidget);
      await close(tester, app);
    });

    testWidgets('Set up Intern 3 is left to Computers, whose list has it', (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('Phone name'));
      expect(find.text('Set up Intern 3'), findsNothing);
      await close(tester, app);
    });

    testWidgets('with no computer, Set up Intern 3 stays: Computers is then '
        'an empty state with Add computer alone', (tester) async {
      final app = await openSettings(tester, swarm: true, noMachines: true);

      await reveal(tester, find.text('Set up Intern 3'));
      expect(inCard('Computers', 'Set up Intern 3'), findsOneWidget);
      expect(
        find.descendant(
          of: rowOf('Set up Intern 3'),
          matching: find.byIcon(LucideIcons.server300),
        ),
        findsOneWidget,
      );
      await close(tester, app);
    });

    testWidgets("Language closes Terminal's card, under its mic", (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('Language'));
      expect(inCard('Font', 'Language'), findsOneWidget);
      expect(inCard('Font', 'Colors'), findsOneWidget);
      expect(inCard('Font', 'Theme'), findsNothing);
      await close(tester, app);
    });

    testWidgets('Swarm says its name and its switch, with no line under it', (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('Swarm'));
      expect(rowOf('Swarm'), findsOneWidget);
      expect(find.text(PhoneExperiment.swarm.description), findsNothing);
      await close(tester, app);
    });

    testWidgets("Help is one row; its sheet holds Help's three", (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('Help'));
      for (final row in [
        'How Harness works',
        'Try the sample',
        'Show the tips again',
      ]) {
        expect(find.text(row), findsNothing, reason: '$row: not on the page');
      }
      expect(inCard('Help', 'About'), findsOneWidget, reason: 'one card');

      await tester.tap(find.text('Help'));
      await frames(tester);
      for (final row in [
        'How Harness works',
        'Try the sample',
        'Show the tips again',
      ]) {
        expect(find.text(row), findsOneWidget, reason: '$row: in the sheet');
      }
      await dismissSheet(tester);
      expect(find.text('How Harness works'), findsNothing);
      await close(tester, app);
    });

    testWidgets('inside the sample, Help offers no sample to try', (
      tester,
    ) async {
      final app = await openSettings(tester, swarm: true, sample: true);

      expect(captioned('Sample'), findsOneWidget);
      expect(inCard('Leave the sample', 'Usage'), findsOneWidget);
      await reveal(tester, find.text('Help'));
      await tester.tap(find.text('Help'));
      await frames(tester);
      expect(find.text('How Harness works'), findsOneWidget);
      expect(find.text('Show the tips again'), findsOneWidget);
      expect(find.text('Try the sample'), findsNothing);
      await dismissSheet(tester);
      await close(tester, app);
    });

    testWidgets('no Notifications and no Theme: they are on You, one tap '
        'nearer (2026-11-04)', (tester) async {
      final app = await openSettings(tester, swarm: true);

      expect(inCard('Ada Lovelace', 'Usage'), findsOneWidget);
      expect(find.text('Notifications'), findsNothing);
      expect(
        find.byKey(const ValueKey('settings-notifications')),
        findsNothing,
      );

      await reveal(tester, find.text('Text size'));
      expect(find.text('Theme'), findsNothing);
      expect(find.byType(SwarmSegments<AppThemeMode>), findsNothing);
      expect(find.text('App colors'), findsNothing, reason: 'nor the palettes');
      await close(tester, app);
    });

    testWidgets('About is one row with the version and the build; its sheet '
        'holds the Privacy Policy', (tester) async {
      final app = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('1.2.3 (456)'));
      expect(
        find.descendant(of: rowOf('About'), matching: find.text('1.2.3 (456)')),
        findsOneWidget,
      );
      expect(find.text('Build'), findsNothing);
      expect(find.text('Version'), findsNothing);
      expect(find.text('Privacy Policy'), findsNothing);

      await tester.tap(find.text('About'));
      await frames(tester);
      expect(find.text('Version 1.2.3 (456)'), findsOneWidget);
      expect(find.text('Privacy Policy'), findsOneWidget);
      await dismissSheet(tester);
      expect(find.text('Privacy Policy'), findsNothing);
      await close(tester, app);
    });

    testWidgets("its controls stay: the account's sheet, Size's stepper, "
        "Swarm's switch", (tester) async {
      final app = await openSettings(tester, swarm: true);

      await tester.tap(find.text('Ada Lovelace'));
      await frames(tester);
      expect(find.text('Sign out'), findsOneWidget);
      await dismissSheet(tester);

      await reveal(tester, find.text('Size'));
      expect(
        find.descendant(
          of: rowOf('Size'),
          matching: find.byType(SettingsStepper),
        ),
        findsOneWidget,
      );
      await reveal(tester, find.text('Swarm'));
      expect(
        find.descendant(of: rowOf('Swarm'), matching: find.byType(Switch)),
        findsOneWidget,
      );
      await close(tester, app);
    });
  });

  testWidgets("opened from anywhere else, it keeps the phone's own look", (
    tester,
  ) async {
    final app = await openSettings(tester, swarm: false);

    expect(find.byType(SwarmTopBar), findsNothing);
    expect(find.byType(SwarmRow), findsNothing);
    expect(find.text('account'), findsOneWidget);
    expect(faceOf(tester, 'Usage'), terminalFace(tester));
    expect(find.textContaining('a harness finishes'), findsOneWidget);
    expect(find.text('Set up Intern 3'), findsOneWidget);
    await reveal(tester, find.text('voice'));
    expect(find.text('Language'), findsOneWidget);
    await reveal(tester, find.text(PhoneExperiment.swarm.description));
    for (final row in [
      'How Harness works',
      'Try the sample',
      'Show the tips again',
    ]) {
      await reveal(tester, find.text(row));
    }
    await reveal(tester, find.text('Build'));
    await frames(tester);
    expect(find.text('456'), findsOneWidget);
    expect(find.text('Version'), findsOneWidget);
    expect(find.text('Privacy Policy'), findsOneWidget);
    expect(find.text('about'), findsOneWidget, reason: 'a caption');
    expect(find.text('Help'), findsNothing, reason: 'no row of that name');
    await close(tester, app);
  });
}
