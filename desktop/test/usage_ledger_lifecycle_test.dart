import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_ledger_controller.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/usage/ledger/usage_report.dart';

import 'usage_ledger_test.dart'
    show MemorySettings, FakeScanner, sourceOf, entryOf;

class HeldScanner implements LedgerScanner {
  @override
  final provider = LedgerProvider.claude;
  final replies = <Completer<LedgerScanResult>>[];
  final previous = <Map<String, ScannedSource>>[];

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> sources) {
    previous.add(Map.of(sources));
    final reply = Completer<LedgerScanResult>();
    replies.add(reply);
    return reply.future;
  }
}

class HeldSettings extends MemorySettings {
  Completer<String?>? reading;
  Completer<void>? writing;
  int reads = 0;
  final writes = <String>[];

  @override
  Future<String?> read(String key) {
    reads++;
    return reading?.future ?? super.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    writes.add(value);
    await writing?.future;
    await super.write(key, value);
  }
}

class HeldSnapshots extends MemorySnapshotStore {
  Completer<String?>? reading;
  Completer<void>? writing;
  Completer<void>? clearing;
  int writes = 0;
  int clears = 0;

  @override
  Future<String?> read() => reading?.future ?? super.read();

  @override
  Future<void> write(String value) async {
    writes++;
    await writing?.future;
    await super.write(value);
  }

  @override
  Future<void> clear() async {
    clears++;
    await clearing?.future;
    await super.clear();
  }
}

LedgerScanResult figures([int tokens = 100]) => LedgerScanResult(
  sources: [
    sourceOf('fixture.jsonl', [
      entryOf(
        dedupeKey: 'turn',
        totals: UsageTotals(freshInput: tokens),
      ),
    ]),
  ],
);

Future<void> tick() => Future<void>.delayed(Duration.zero);

void main() {
  const enabledKey = 'usageLedger.claude.enabled';
  late HeldSettings settings;
  late HeldSnapshots snapshots;
  late HeldScanner scanner;
  late UsageLedgerStore store;

  setUp(() {
    settings = HeldSettings();
    snapshots = HeldSnapshots();
    scanner = HeldScanner();
    store = UsageLedgerStore(
      scanner: scanner,
      settings: settings,
      snapshots: snapshots,
    );
  });
  tearDown(() => store.dispose());

  test(
    'partial scans keep readable figures, disclose gaps, and retry immediately',
    () async {
      await store.load();
      final enabling = store.setEnabled(true);
      await tick();
      scanner.replies.single.complete(figures(500));
      await enabling;
      expect(snapshots.isEmpty, isFalse);
      final refreshing = store.refresh(force: true);
      await tick();
      scanner.replies.last.complete(
        LedgerScanResult(
          sources: figures(100).sources,
          status: LedgerStatus.partial,
          message: 'One source could not be read. Figures are incomplete.',
        ),
      );
      await refreshing;
      expect(store.ledger.totals.total, 100);
      expect(store.state.hasIncompleteFigures, isTrue);
      expect(snapshots.isEmpty, isTrue);
      final retrying = store.refresh();
      await tick();
      expect(scanner.replies, hasLength(3));
      expect(store.state.status, LedgerStatus.scanning);
      expect(store.state.hasIncompleteFigures, isTrue);
      scanner.replies.last.complete(figures(250));
      await retrying;
      expect(store.ledger.totals.total, 250);
      expect(store.state.status, LedgerStatus.ok);
      expect(store.state.hasIncompleteFigures, isFalse);
      expect(store.state.message, isNull);
      expect(snapshots.isEmpty, isFalse);
    },
  );

  test(
    'reopening after a partial scan cannot restore it as complete',
    () async {
      await store.load();
      final enabling = store.setEnabled(true);
      await tick();
      scanner.replies.single.complete(
        LedgerScanResult(
          sources: figures().sources,
          status: LedgerStatus.partial,
          message: 'Figures are incomplete.',
        ),
      );
      await enabling;
      final secondScanner = HeldScanner();
      final reopened = UsageLedgerStore(
        scanner: secondScanner,
        settings: settings,
        snapshots: snapshots,
      );
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.state.enabled, isTrue);
      expect(reopened.ledger.hasData, isFalse);
      final scanning = reopened.refresh();
      await tick();
      expect(secondScanner.replies, hasLength(1));
      secondScanner.replies.single.complete(figures(300));
      await scanning;
      expect(reopened.ledger.totals.total, 300);
    },
  );

  test('a completed scan cannot undo Off or recreate its snapshot', () async {
    await store.load();
    final enabling = store.setEnabled(true);
    await tick();
    expect(scanner.replies, hasLength(1));
    await store.setEnabled(false);
    scanner.replies.single.complete(figures());
    await enabling;
    expect(store.state.enabled, isFalse);
    expect(store.state.status, LedgerStatus.disabled);
    expect(store.state.lastScanAt, isNull);
    expect(store.ledger.hasData, isFalse);
    expect(snapshots.isEmpty, isTrue);
    expect(settings.values[enabledKey], 'false');
  });

  test(
    'Off removes figures immediately while settings persistence is delayed',
    () async {
      final enabled = store.setEnabled(true);
      await tick();
      scanner.replies.single.complete(figures());
      await enabled;
      final gate = settings.writing = Completer<void>();
      final disabled = store.setEnabled(false);
      expect(store.state.status, LedgerStatus.disabled);
      expect(store.state.lastScanAt, isNull);
      expect(store.ledger.hasData, isFalse);
      gate.complete();
      await disabled;
      expect(snapshots.isEmpty, isTrue);
    },
  );

  for (final oldResult in [false, true]) {
    test(
      'a delayed $oldResult preference cannot overwrite a newer toggle',
      () async {
        final gate = settings.reading = Completer<String?>();
        final loaded = store.load();
        await tick();
        final changed = store.setEnabled(!oldResult);
        await tick();
        gate.complete('$oldResult');
        await loaded;
        if (!oldResult) {
          expect(scanner.replies, hasLength(1));
          scanner.replies.single.complete(figures());
        }
        await changed;
        expect(store.state.enabled, !oldResult);
        expect(settings.values[enabledKey], '${!oldResult}');
      },
    );
  }

  test('a delayed snapshot cannot restore figures after Off', () async {
    final prepared = UsageLedgerStore(
      scanner: FakeScanner(LedgerProvider.claude, figures()),
      settings: settings,
      snapshots: snapshots,
    );
    await prepared.setEnabled(true);
    final cached = snapshots.contents;
    prepared.dispose();
    final gate = snapshots.reading = Completer<String?>();
    final loaded = store.load();
    await tick();
    await store.setEnabled(false);
    gate.complete(cached);
    await loaded;
    expect(store.state.enabled, isFalse);
    expect(store.state.lastScanAt, isNull);
    expect(store.ledger.hasData, isFalse);
    expect(snapshots.isEmpty, isTrue);
  });

  test(
    'Off then On waits for the old scan and scans again with empty sources',
    () async {
      final first = store.setEnabled(true);
      await tick();
      await store.setEnabled(false);
      final second = store.setEnabled(true);
      await tick();
      expect(
        scanner.replies,
        hasLength(1),
        reason: 'Disk scans must not overlap',
      );
      scanner.replies.first.complete(figures(900));
      await first;
      await tick();
      expect(store.ledger.hasData, isFalse);
      expect(scanner.replies, hasLength(2));
      expect(scanner.previous.last, isEmpty);
      scanner.replies.last.complete(figures(20));
      await second;
      expect(store.ledger.totals.total, 20);
      expect(store.state.status, LedgerStatus.ok);
    },
  );

  test('a queued cache write finishes before Off clears it', () async {
    final gate = snapshots.writing = Completer<void>();
    final enabled = store.setEnabled(true);
    await tick();
    scanner.replies.single.complete(figures());
    await tick();
    expect(snapshots.writes, 1);
    final disabled = store.setEnabled(false);
    await tick();
    gate.complete();
    await Future.wait([enabled, disabled]);
    expect(snapshots.isEmpty, isTrue);
    expect(store.ledger.hasData, isFalse);
  });

  test(
    'rapid toggles persist in order and cannot publish the first scan',
    () async {
      final gate = settings.writing = Completer<void>();
      final on = store.setEnabled(true);
      await tick();
      final off = store.setEnabled(false);
      final onAgain = store.setEnabled(true);
      final offAgain = store.setEnabled(false);
      gate.complete();
      await tick();
      for (final reply in scanner.replies) {
        reply.complete(figures());
      }
      await Future.wait([on, off, onAgain, offAgain]);
      expect(settings.writes, ['true', 'false', 'true', 'false']);
      expect(settings.values[enabledKey], 'false');
      expect(store.state.status, LedgerStatus.disabled);
      expect(store.ledger.hasData, isFalse);
      expect(snapshots.isEmpty, isTrue);
    },
  );

  for (final throws in [false, true]) {
    test(
      '${throws ? 'thrown' : 'returned'} failure drops stale totals and allows immediate retry',
      () async {
        final enabled = store.setEnabled(true);
        await tick();
        scanner.replies.single.complete(figures());
        await enabled;
        final failed = store.refresh(force: true);
        await tick();
        if (throws) {
          scanner.replies.last.completeError(
            StateError('Fixture is unavailable'),
          );
        } else {
          scanner.replies.last.complete(
            const LedgerScanResult.unavailable('No fixture logs'),
          );
        }
        await failed;
        expect(store.state.lastScanAt, isNull);
        expect(store.ledger.hasData, isFalse);
        expect(snapshots.isEmpty, isTrue);
        final retry = store.refresh();
        await tick();
        expect(scanner.replies, hasLength(3));
        scanner.replies.last.complete(figures(25));
        await retry;
        expect(store.ledger.totals.total, 25);
      },
    );
  }

  test(
    'closing and reopening waits for an already requested Off to persist',
    () async {
      final enabled = store.setEnabled(true);
      await tick();
      scanner.replies.single.complete(figures());
      await enabled;
      final gate = settings.writing = Completer<void>();
      final disabled = store.setEnabled(false);
      // A second controller is what reopening the settings section creates.
      final reopened = UsageLedgerStore(
        scanner: scanner,
        settings: settings,
        snapshots: snapshots,
      );
      addTearDown(reopened.dispose);
      final loaded = reopened.load();
      await tick();
      gate.complete();
      await Future.wait([disabled, loaded]);
      expect(reopened.state.enabled, isFalse);
      expect(reopened.ledger.hasData, isFalse);
      expect(snapshots.isEmpty, isTrue);
    },
  );

  test('load is shared and does not undo current in-session choices', () async {
    settings.reading = Completer<String?>();
    final first = store.load();
    final second = store.load();
    await tick();
    expect(settings.reads, 1);
    settings.reading!.complete('false');
    await Future.wait([first, second]);
    final enabled = store.setEnabled(true);
    await tick();
    scanner.replies.single.complete(figures());
    await enabled;
    await store.load();
    expect(settings.reads, 1);
    expect(store.ledger.totals.total, 100);
  });

  test('a synchronous scan listener cannot start a duplicate scan', () async {
    final enabled = store.setEnabled(true);
    await tick();
    scanner.replies.single.complete(figures());
    await enabled;
    Future<void>? joined;
    var requested = false;
    store.addListener(() {
      if (!requested && store.state.status == LedgerStatus.scanning) {
        requested = true;
        joined = store.refresh(force: true);
      }
    });
    final refreshed = store.refresh(force: true);
    await tick();
    expect(scanner.replies, hasLength(2));
    scanner.replies.last.complete(figures());
    await refreshed;
    await joined;
  });

  test(
    'Retry after a visible failure waits for cache cleanup then scans again',
    () async {
      final gate = snapshots.clearing = Completer<void>();
      final first = store.setEnabled(true);
      await tick();
      scanner.replies.single.completeError(StateError('Fixture read failed'));
      await tick();
      expect(store.state.status, LedgerStatus.failed);
      final retry = store.refresh(force: true);
      gate.complete();
      await first;
      await tick();
      expect(scanner.replies, hasLength(2));
      scanner.replies.last.complete(figures());
      await retry;
      expect(store.ledger.hasData, isTrue);
    },
  );

  for (final fail in [false, true]) {
    test(
      'a late ${fail ? 'failed' : 'successful'} scan after disposal has no effects',
      () async {
        final probe = HeldScanner();
        final cache = MemorySnapshotStore();
        final owned = UsageLedgerStore(
          scanner: probe,
          settings: MemorySettings(),
          snapshots: cache,
        );
        var notifications = 0;
        owned.addListener(() => notifications++);
        final enabled = owned.setEnabled(true);
        await tick();
        owned.dispose();
        final count = notifications;
        if (fail) {
          probe.replies.single.completeError(
            StateError('Late fixture failure'),
          );
        } else {
          probe.replies.single.complete(figures());
        }
        await enabled;
        await owned.refresh(force: true);
        expect(cache.isEmpty, isTrue);
        expect(notifications, count);
        expect(probe.replies, hasLength(1));
      },
    );
  }

  test(
    'disposing a controller during load never scans or notifies afterward',
    () async {
      final delayed = HeldSettings()..reading = Completer<String?>();
      final probe = HeldScanner();
      final owned = UsageLedgerStore(
        scanner: probe,
        settings: delayed,
        snapshots: MemorySnapshotStore(),
      );
      final controller = UsageLedgerController(stores: [owned]);
      var notifications = 0;
      controller.addListener(() => notifications++);
      final loading = controller.load();
      await tick();
      controller.dispose();
      final count = notifications;
      delayed.reading!.complete('true');
      await loading;
      expect(notifications, count);
      expect(probe.replies, isEmpty);
    },
  );

  test(
    'overview ranges follow midnight, new scans, failures, and Off',
    () async {
      final source = FakeScanner(LedgerProvider.claude, figures());
      final owned = UsageLedgerStore(
        scanner: source,
        settings: MemorySettings(),
        snapshots: MemorySnapshotStore(),
      );
      final controller = UsageLedgerController(stores: [owned]);
      addTearDown(controller.dispose);
      await controller.load();
      await owned.setEnabled(true);
      expect(
        controller
            .overviewFor(UsageRange.d7, now: DateTime(2026, 9, 7, 23))
            .totals
            .total,
        100,
      );
      expect(controller.overviewFor(UsageRange.all).totals.total, 100);
      // The application can stay open across midnight with no new scan event.
      expect(
        controller
            .overviewFor(UsageRange.d7, now: DateTime(2026, 9, 8))
            .totals
            .total,
        0,
      );
      source.result = figures(200);
      await owned.refresh(force: true);
      expect(controller.overviewFor(UsageRange.all).totals.total, 200);
      source.result = const LedgerScanResult.unavailable('No fixture');
      await owned.refresh(force: true);
      expect(controller.overviewFor(UsageRange.all).totals.total, 0);
      expect(controller.overviewFor(UsageRange.all).lastScanAt, isNull);
      await owned.setEnabled(false);
      expect(controller.overviewFor(UsageRange.all).enabledCount, 0);
    },
  );
}
