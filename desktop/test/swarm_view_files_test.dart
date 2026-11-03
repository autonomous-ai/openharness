// Desktop keeps each Swarm's saved view in a private file of its own beside
// the settings `state.json`, never in it: every setting, pane or theme write
// rewrites that document under its lock, and it holds credentials. Views the
// 1.3.27+ builds wrote into it move out once, for the account they belong to.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/super_tabs/account_keys.dart';
import 'package:harness/super_tabs/saved_view.dart';

import 'super_tab_saved_view_test.dart' show savedViewForTest;

class _RecordingLog implements AppLog {
  final warnings = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (level == AppLogLevel.warn && category == 'swarm') {
      warnings.add('$message ${error ?? ''}');
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory scratch;
  late HarnessFileStore settings;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('swarm-view-files-test-');
    settings = HarnessFileStore(
      directory: Directory('${scratch.path}/desktop-app-v2'),
    );
  });

  tearDown(() async {
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  /// The app as `appStateProvider` builds it, with its settings in [settings].
  AppNotifier app() {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      paneLayoutStore: PaneLayoutStore(storage: settings),
    );
    addTearDown(app.dispose);
    return app;
  }

  SuperTabSavedViews views(AppNotifier app) =>
      SuperTabSavedViews(app.superTabs.viewStorage);

  /// What a 1.3.27+ build left in the settings document: the view, the
  /// account's index and whose device this is, all beside the credentials.
  Future<void> savedByOldBuild(
    HarnessFileStore store, {
    String account = 'owner',
    String tab = 'tab',
    int pad = 0,
  }) async {
    final old = SuperTabSavedViews(store);
    await old.claim(account);
    expect(await old.write(account, tab, savedViewForTest(pad: pad)), isTrue);
  }

  Directory viewsDirectory() =>
      Directory('${settings.directory.path}/swarm-views');

  List<File> viewFiles() {
    final directory = viewsDirectory();
    if (!directory.existsSync()) return const [];
    return directory
        .listSync()
        .whereType<File>()
        .where((f) => f.uri.pathSegments.last.startsWith('view.'))
        .where((f) => f.path.endsWith('.json'))
        .toList();
  }

  Future<Set<String>> savedKeys(HarnessFileStore store) async {
    if (!await store.stateFile.exists()) return {};
    final values =
        (jsonDecode(await store.stateFile.readAsString())
                as Map<String, dynamic>)['values']
            as Map<String, dynamic>;
    return values.keys
        .where(
          (k) =>
              k.startsWith('super_tab.view.') ||
              k.startsWith('super_tab.views.') ||
              k == 'super_tab.saved_by',
        )
        .toSet();
  }

  group('the real app', () {
    test('never hands saved views the settings store', () {
      final real = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        paneLayoutStore: PaneLayoutStore(),
      );
      addTearDown(real.dispose);
      expect(real.localStore, same(HarnessFileStore.shared));
      // The settings store, behind the web's guard on a signed-out account's
      // writes (super_tabs/account_keys.dart).
      expect(
        (real.superTabs.storage as SwarmAccountStorage).inner,
        same(HarnessFileStore.shared),
      );
      expect(real.superTabs.viewStorage, isNot(same(HarnessFileStore.shared)));
      expect(real.superTabs.viewStorage, isNot(isA<HarnessFileStore>()));
    });

    test(
      'writing a saved view leaves the settings state.json unchanged',
      () async {
        await settings.write('theme', 'dark');
        final before = await settings.stateFile.readAsBytes();
        final kept = views(app());
        await kept.claim('owner');
        expect(await kept.write('owner', 'tab', savedViewForTest()), isTrue);
        expect(await settings.stateFile.readAsBytes(), before);
        expect(viewFiles(), hasLength(1));
        expect(await kept.readInTurn('owner', 'tab'), isNotNull);
      },
    );
  });

  group('one file per Swarm', () {
    test('a view is a private file, in a private directory', () async {
      final kept = views(app());
      await kept.claim('owner');
      await kept.write('owner', 'tab', savedViewForTest());
      expect(viewFiles(), hasLength(1));
      final file = viewFiles().single;
      expect((await file.stat()).mode & 0xfff, 0x180); // 0600
      expect((await viewsDirectory().stat()).mode & 0xfff, 0x1c0); // 0700
    }, skip: Platform.isWindows);

    test("writing one Swarm's view leaves another's file as it was", () async {
      final kept = views(app());
      await kept.claim('owner');
      await kept.write('owner', 'a', savedViewForTest(tab: 'a'));
      expect(viewFiles(), hasLength(1));
      final a = viewFiles().single;
      final before = await a.readAsString();
      final modified = (await a.stat()).modified;
      await kept.write('owner', 'b', savedViewForTest(tab: 'b', pad: 1000));
      expect(viewFiles(), hasLength(2));
      expect(await a.readAsString(), before);
      expect((await a.stat()).modified, modified);
    });

    test('signing out removes the files', () async {
      final kept = views(app());
      await kept.claim('owner');
      await kept.write('owner', 'a', savedViewForTest(tab: 'a'));
      await kept.write('owner', 'b', savedViewForTest(tab: 'b'));
      expect(viewFiles(), hasLength(2));
      await kept.claim(null);
      expect(viewFiles(), isEmpty);
    });

    test("another account signing in removes the last one's files", () async {
      final kept = views(app());
      await kept.claim('owner');
      await kept.write('owner', 'tab', savedViewForTest());
      expect(viewFiles(), hasLength(1));
      await kept.claim('other');
      expect(viewFiles(), isEmpty);
      expect(await kept.readInTurn('owner', 'tab'), isNull);
    });
  });

  group('nothing of an account stays behind', () {
    /// A view of [account] no index lists (a stop between the view's write
    /// and its index's), and a temporary left beside its file by a stop
    /// mid-write.
    Future<void> leftovers(AppNotifier app, String account) async {
      final store = app.superTabs.viewStorage;
      final before = viewFiles().map((f) => f.path).toSet();
      await store.write(
        '${SuperTabSavedViews.viewPrefix}$account.lost',
        jsonEncode(savedViewForTest()),
      );
      final lost = viewFiles().singleWhere((f) => !before.contains(f.path));
      await File('${lost.path}.999.1.tmp').writeAsString('Pilot');
    }

    List<String> left() => viewsDirectory().existsSync()
        ? viewsDirectory()
              .listSync()
              .map((e) => e.uri.pathSegments.where((s) => s.isNotEmpty).last)
              .where((n) => n.startsWith('view.'))
              .toList()
        : const [];

    test(
      'signing out removes its files, listed or not, temporaries too',
      () async {
        final shown = app();
        final kept = views(shown);
        await kept.claim('owner');
        await kept.write('owner', 'tab', savedViewForTest());
        await leftovers(shown, 'owner');
        expect(left(), hasLength(3));
        await kept.claim(null);
        expect(left(), isEmpty);
      },
    );

    test("another account signing in removes all of the last one's", () async {
      final shown = app();
      final kept = views(shown);
      await kept.claim('owner');
      await kept.write('owner', 'tab', savedViewForTest());
      await leftovers(shown, 'owner');
      await kept.claim('other');
      expect(left(), isEmpty);
      expect(await kept.write('other', 'tab', savedViewForTest()), isTrue);
      expect(left(), hasLength(1));
    });

    test("Clear now removes the account's unlisted files too", () async {
      final shown = app();
      final kept = views(shown);
      await kept.claim('owner');
      await kept.write('owner', 'tab', savedViewForTest());
      await leftovers(shown, 'owner');
      await kept.clear('owner');
      expect(left(), isEmpty);
    });

    test('a new start removes temporaries a stop left behind', () async {
      final kept = views(app());
      await kept.claim('owner');
      await kept.write('owner', 'tab', savedViewForTest());
      await File('${viewFiles().single.path}.999.1.tmp').writeAsString('Pilot');
      expect(left(), hasLength(2));

      final again = views(app());
      expect(await again.readInTurn('owner', 'tab'), isNotNull);
      expect(left(), hasLength(1));
    });

    test(
      'a file that will not go is logged, without its path or content',
      () async {
        final log = _RecordingLog();
        final previous = appLog;
        appLog = log;
        addTearDown(() => appLog = previous);
        final kept = views(app());
        await kept.claim('owner');
        await kept.write('owner', 'tab', savedViewForTest());
        // A folder where the view's file was: no file delete removes it.
        final file = viewFiles().single;
        await file.delete();
        await File('${file.path}/inside').create(recursive: true);

        await kept.claim(null);
        expect(log.warnings, isNotEmpty);
        for (final warning in log.warnings) {
          expect(warning, isNot(contains(scratch.path)));
          expect(warning, isNot(contains('view.')));
          expect(warning, isNot(contains('Pilot')));
        }
      },
      skip: Platform.isWindows,
    );
  });

  group('the views an older build kept in state.json', () {
    test(
      'still open, then leave it, and a theme flip writes under 50 KB',
      () async {
        await settings.write('theme', 'light');
        await savedByOldBuild(settings, pad: 204 * 1024);
        expect(await settings.stateFile.length(), greaterThan(200 * 1024));

        final kept = views(app());
        expect((await kept.readInTurn('owner', 'tab'))?['lastChangedAt'], 7);
        expect(viewFiles(), hasLength(1));
        expect(await savedKeys(settings), isEmpty);
        expect(await settings.read('theme'), 'light');

        await settings.write('theme', 'dark');
        expect(await settings.stateFile.length(), lessThan(50 * 1024));
      },
    );

    test("are kept for the same account, and its Swarms' order", () async {
      await savedByOldBuild(settings, tab: 'a');
      final old = SuperTabSavedViews(settings);
      await old.write('owner', 'b', savedViewForTest(tab: 'b'));

      final kept = views(app());
      // Still this account's device: a write keeps, and the index moved too.
      expect(
        await kept.write('owner', 'c', savedViewForTest(tab: 'c')),
        isTrue,
      );
      expect(viewFiles(), hasLength(3));
      await kept.write('owner', 'd', savedViewForTest(tab: 'd'));
      // Three per account, most recent first: 'a', the oldest, went.
      expect(await kept.readInTurn('owner', 'a'), isNull);
      expect(await kept.readInTurn('owner', 'b'), isNotNull);
    });

    test("another account's leftover view is deleted, never moved", () async {
      await savedByOldBuild(settings);
      // A view of an account that no longer uses this device.
      await settings.write(
        'super_tab.view.ghost.tab',
        jsonEncode(savedViewForTest()),
      );
      await settings.write('super_tab.views.ghost', jsonEncode(['tab']));

      final kept = views(app());
      expect(await kept.readInTurn('owner', 'tab'), isNotNull);
      expect(await kept.readInTurn('ghost', 'tab'), isNull);
      expect(viewFiles(), hasLength(1));
      expect(await savedKeys(settings), isEmpty);
      expect(await settings.stateFile.readAsString(), isNot(contains('Pilot')));
    });

    test('a move cut short after the file was written finishes', () async {
      await savedByOldBuild(settings);
      final legacy = await settings.read('super_tab.view.owner.tab');
      final index = await settings.read('super_tab.views.owner');
      expect(await views(app()).readInTurn('owner', 'tab'), isNotNull);
      // As if the app stopped after the file but before the keys went.
      await settings.write('super_tab.view.owner.tab', legacy!);
      await settings.write('super_tab.views.owner', index!);
      await settings.write('super_tab.saved_by', 'owner');

      final again = views(app());
      expect(await again.readInTurn('owner', 'tab'), isNotNull);
      expect(viewFiles(), hasLength(1));
      expect(await savedKeys(settings), isEmpty);
    });

    test('a newer view in its file wins over an old key left behind', () async {
      await savedByOldBuild(settings);
      final legacy = await settings.read('super_tab.view.owner.tab');
      final first = views(app());
      final newer = savedViewForTest()..['lastChangedAt'] = 99;
      expect(await first.write('owner', 'tab', newer), isTrue);
      await settings.write('super_tab.view.owner.tab', legacy!);

      final again = views(app());
      expect((await again.readInTurn('owner', 'tab'))!['lastChangedAt'], 99);
      expect(await savedKeys(settings), isEmpty);
    });

    test('a view in the unused swarm-views state.json moves too', () async {
      final unused = HarnessFileStore(directory: viewsDirectory());
      await savedByOldBuild(unused);

      final kept = views(app());
      expect(await kept.readInTurn('owner', 'tab'), isNotNull);
      expect(viewFiles(), hasLength(1));
      final left = await unused.stateFile.readAsString();
      expect(left, isNot(contains('super_tab.view.owner.tab')));
      expect(await unused.stateFile.length(), lessThan(50 * 1024));
    });
  });
}
