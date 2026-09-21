import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/settings/sections/usage_panels.dart';
import 'package:harness/settings/sections/usage_detail_panels.dart';
import 'package:harness/settings/sections/usage_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/stats/harness_stats.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_ledger_controller.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/usage/ledger/usage_report.dart';

import 'support/real_fonts.dart';
import 'usage_ledger_lifecycle_test.dart' show HeldScanner, HeldSettings;
import 'usage_ledger_test.dart'
    show FakeScanner, MemorySettings, sourceOf, entryOf;

LedgerScanResult _figures([int tokens = 1200]) => LedgerScanResult(
  sources: [
    sourceOf('fixture.jsonl', [
      entryOf(
        timestamp: DateTime.now()
            .subtract(const Duration(hours: 2))
            .toIso8601String(),
        totals: UsageTotals(freshInput: tokens),
        dedupeKey: 'fixture-turn',
      ),
    ]),
  ],
);

void main() {
  setUpAll(() async {
    await loadRealFonts();
    for (final (family, path) in [
      ('MaterialIcons', 'fonts/MaterialIcons-Regular.otf'),
      (
        'packages/lucide_icons_flutter/Lucide300',
        'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
      ),
    ]) {
      await (FontLoader(family)..addFont(rootBundle.load(path))).load();
    }
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      testWidgets(
        'Usage waiting, retry, range, and Off — ${brightness.name}, $scale',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(880, 560);
          addTearDown(tester.view.reset);
          final oldBrightness = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
          final settings = HeldSettings()..reading = Completer<String?>();
          final scanner = HeldScanner();
          final snapshot = MemorySnapshotStore();
          final store = UsageLedgerStore(
            scanner: scanner,
            settings: settings,
            snapshots: snapshot,
          );
          final controller = UsageLedgerController(
            stores: [
              store,
              for (final provider in [
                LedgerProvider.codex,
                LedgerProvider.opencode,
              ])
                UsageLedgerStore(
                  scanner: FakeScanner(provider, const LedgerScanResult()),
                  settings: MemorySettings(),
                  snapshots: MemorySnapshotStore(),
                ),
            ],
          );
          final stats = HarnessStats(store: MemorySnapshotStore());
          addTearDown(controller.dispose);
          addTearDown(stats.dispose);
          final loading = controller.load();
          final boundary = GlobalKey();
          Future<void> capture(String stage) async {
            final directory = Platform.environment['HARNESS_USAGE_CAPTURE_DIR'];
            if (directory == null) return;
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            await tester.runAsync(() async {
              final image = await render.toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(directory).create(recursive: true);
              await File('$directory/$stage-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }

          Future<void> key(LogicalKeyboardKey key) async {
            await tester.sendKeyEvent(key);
            await tester.pumpAndSettle();
          }

          await tester.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: grid.buildAppTheme(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context).copyWith(
                    textScaler: TextScaler.linear(scale),
                    disableAnimations: true,
                  ),
                  child: grid.BrightnessScope(child: child!),
                ),
                home: Scaffold(
                  body: UsageSection(controller: controller, stats: stats),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Reading usage settings…'), findsOneWidget);
          expect(find.text('Enable Claude'), findsNothing);
          expect(find.byType(ProviderUsageRow), findsNothing);
          await capture('settings-loading');

          settings.reading!.complete('true');
          await tester.pumpAndSettle();
          expect(scanner.replies, hasLength(1));
          expect(find.text('Scanning local logs…'), findsOneWidget);
          expect(find.text('0 tokens'), findsNothing);
          expect(find.text('0 sessions'), findsNothing);
          expect(find.textContaining('0 with data'), findsNothing);
          await capture('overview-scanning');

          final lens = find.byType(AppSelectField<LedgerProvider?>);
          Future<void> revealLens() => tester.scrollUntilVisible(
            lens,
            -200,
            scrollable: find.byType(Scrollable).first,
          );
          await revealLens();
          await tester.tap(lens);
          await tester.pumpAndSettle();
          await key(LogicalKeyboardKey.arrowDown);
          await key(LogicalKeyboardKey.enter);
          expect(find.text('Scanning Claude logs…'), findsOneWidget);
          expect(find.text('No Claude usage in this range.'), findsNothing);
          await capture('provider-scanning');

          scanner.replies.single.completeError(
            StateError('Fixture logs are temporarily unavailable.'),
          );
          await tester.pumpAndSettle();
          await loading;
          expect(
            find.textContaining('temporarily unavailable'),
            findsOneWidget,
          );
          expect(find.text('Fresh input'), findsNothing);
          await capture('provider-failed');

          final rescan = find.byTooltip('Rescan the local logs');
          await tester.ensureVisible(rescan);
          await tester.tap(rescan);
          await tester.pumpAndSettle();
          expect(scanner.replies, hasLength(2));
          const incomplete =
              'Could not read 1 of 2 Claude transcripts. Figures are incomplete.';
          scanner.replies.last.complete(
            LedgerScanResult(
              sources: _figures().sources,
              status: LedgerStatus.partial,
              message: incomplete,
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Fresh input'), findsWidgets);
          expect(find.text(incomplete), findsOneWidget);
          await tester.ensureVisible(find.text(incomplete));
          await tester.pumpAndSettle();
          await capture('provider-partial');
          await revealLens();
          await tester.tap(lens);
          await tester.pumpAndSettle();
          await key(LogicalKeyboardKey.arrowUp);
          await key(LogicalKeyboardKey.enter);
          expect(find.text('Incomplete'), findsOneWidget);
          final warning = find.text(
            'Some usage could not be read. Totals are incomplete.',
          );
          expect(warning, findsOneWidget);
          await tester.ensureVisible(warning);
          await tester.pumpAndSettle();
          await capture('overview-partial');
          await revealLens();
          await tester.tap(lens);
          await tester.pumpAndSettle();
          await key(LogicalKeyboardKey.arrowDown);
          await key(LogicalKeyboardKey.enter);
          final range = find.byType(AppSelectField<UsageRange>);
          await tester.ensureVisible(range);
          await tester.tap(range);
          await tester.pumpAndSettle();
          await key(LogicalKeyboardKey.arrowDown);
          await key(LogicalKeyboardKey.arrowDown);
          await key(LogicalKeyboardKey.enter);
          expect(
            tester.widget<AppSelectField<UsageRange>>(range).value,
            UsageRange.all,
          );
          expect(
            scanner.replies,
            hasLength(2),
            reason: 'Changing range must not walk the disk',
          );
          await tester.ensureVisible(rescan);
          await tester.tap(rescan);
          await tester.pumpAndSettle();
          expect(scanner.replies, hasLength(3));
          expect(find.text(incomplete), findsOneWidget);
          expect(
            find.text('Fresh input'),
            findsWidgets,
            reason: 'A rescan retains the previous figures',
          );
          await capture('provider-rescanning');

          final off = find.byTooltip('Stop reading Claude');
          await tester.ensureVisible(off);
          await tester.tap(off);
          await tester.pumpAndSettle();
          expect(find.text('Enable Claude'), findsOneWidget);
          expect(find.text('Fresh input'), findsNothing);
          scanner.replies.last.complete(_figures(9900));
          await tester.pumpAndSettle();
          expect(find.text('Enable Claude'), findsOneWidget);
          expect(store.state.enabled, isFalse);
          expect(snapshot.isEmpty, isTrue);
          await capture('provider-off');
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets('daily bars share a baseline and large labels remain readable', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 700);
    addTearDown(tester.view.reset);
    final days = [
      LedgerDay(
        day: DateTime(2026, 9, 19),
        totals: const UsageTotals(freshInput: 100),
      ),
      LedgerDay(
        day: DateTime(2026, 9, 20),
        totals: const UsageTotals(freshInput: 200),
      ),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(2.5)),
          child: child!,
        ),
        home: Scaffold(
          body: SingleChildScrollView(child: UsageDailyChart(days: days)),
        ),
      ),
    );
    await tester.pumpAndSettle();
    Finder bar(String label) => find.descendant(
      of: find.byTooltip(label),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is Container &&
            widget.color == usageBucketColours.freshInput,
      ),
    );
    final small = tester.getRect(bar('2026-09-19\n100 tokens'));
    final large = tester.getRect(bar('2026-09-20\n200 tokens'));
    expect(small.bottom, closeTo(large.bottom, .01));
    expect(small.height * 2, closeTo(large.height, .01));
    for (final label in ['100', '200', '09-19', '09-20']) {
      final paragraph = tester.renderObject<RenderParagraph>(find.text(label));
      expect(paragraph.didExceedMaxLines, isFalse);
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
