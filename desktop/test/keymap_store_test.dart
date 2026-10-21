import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_edit.dart';
import 'package:harness/shortcuts/keymap_store.dart';

String config(String command) => jsonEncode({
  'bindings': [
    {'keys': 'cmd+t', 'command': command},
  ],
});
KeymapStore storeFor(File file, {bool watch = false, File? legacyFile}) =>
    KeymapStore(
      file: file,
      legacyFile: legacyFile,
      watchFiles: watch,
      defaults: [
        KeyBinding(keys: [KeyStroke.parse('cmd+t')], command: 'swarm.new'),
      ],
      commands: {'swarm.new', 'pane.focus_left'},
    );
String? selected(KeymapStore store) => store.current.match(
  KeymapContext.terminal,
  [KeyStroke.parse('cmd+t')],
).command;

Future<void> eventually(bool Function() condition) async {
  final until = DateTime.now().add(const Duration(seconds: 5));
  while (!condition()) {
    if (DateTime.now().isAfter(until)) {
      fail('Directory watch did not publish the expected keymap');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

class _ControlledFile extends Fake implements File {
  final reads = <StreamController<List<int>>>[];
  @override
  Stream<List<int>> openRead([int? start, int? end]) {
    final controller = StreamController<List<int>>();
    reads.add(controller);
    return controller.stream;
  }
}

class _PausedResolutionFile extends Fake implements File {
  _PausedResolutionFile(this.delegate);
  final File delegate;
  Completer<void>? resolutionGate;
  final resolutionPaused = Completer<void>();

  @override
  File get absolute => delegate.absolute;
  @override
  Stream<List<int>> openRead([int? start, int? end]) =>
      delegate.openRead(start, end);
  @override
  Future<String> resolveSymbolicLinks() async {
    final gate = resolutionGate;
    if (gate != null) {
      if (!resolutionPaused.isCompleted) resolutionPaused.complete();
      await gate.future;
      resolutionGate = null;
    }
    return delegate.resolveSymbolicLinks();
  }
}

void main() {
  late Directory directory;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('harness-keymap-test-');
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });

  test('Windows paths use AppData and keep the legacy path available', () {
    const environment = {
      'APPDATA': r'C:\Users\u\AppData\Roaming',
      'USERPROFILE': r'C:\Users\u',
      'HOME': '/shell/home',
    };
    const canonical = r'C:\Users\u\AppData\Roaming\harness\keybindings.jsonc';
    const legacy = r'C:\Users\u\.config\harness\keybindings.jsonc';
    expect(
      KeymapStore.defaultPath(environment: environment, isWindows: true),
      canonical,
    );
    expect(
      KeymapStore.legacyPath(environment: environment, isWindows: true),
      legacy,
    );
    final store = AppKeymap.fileStore(
      environment: environment,
      isWindows: true,
    );
    addTearDown(store.dispose);
    expect(store.file.path, canonical);
    expect(store.legacyFile?.path, legacy);
  });

  test('Windows factory accepts AppData without an available legacy root', () {
    const environment = {'APPDATA': r'C:\Roaming'};
    final store = AppKeymap.fileStore(
      environment: environment,
      isWindows: true,
    );
    addTearDown(store.dispose);
    expect(store.file.path, r'C:\Roaming\harness\keybindings.jsonc');
    expect(store.legacyFile, isNull);
    expect(
      KeymapStore.legacyPath(environment: environment, isWindows: true),
      isNull,
    );
  });

  test('Windows factory still rejects an environment with no config root', () {
    expect(
      () => AppKeymap.fileStore(environment: const {}, isWindows: true),
      throwsA(isA<FileSystemException>()),
    );
  });

  test('Windows falls back when AppData is absent or relative', () {
    for (final appData in [null, '', 'relative']) {
      expect(
        KeymapStore.defaultPath(
          environment: {'USERPROFILE': r'C:\Users\u', 'APPDATA': ?appData},
          isWindows: true,
        ),
        r'C:\Users\u\.config\harness\keybindings.jsonc',
      );
    }
    expect(
      KeymapStore.defaultPath(
        environment: {
          'APPDATA': 'relative',
          'USERPROFILE': r'C:\Users\u',
          'XDG_CONFIG_HOME': r'D:\Config',
        },
        isWindows: true,
      ),
      r'D:\Config\harness\keybindings.jsonc',
    );
  });

  test('non-Windows keeps XDG paths and has no migration source', () {
    const environment = {
      'HOME': '/users/dev',
      'APPDATA': r'C:\Roaming',
      'XDG_CONFIG_HOME': '/dotfiles',
    };
    expect(
      KeymapStore.defaultPath(environment: environment, isWindows: false),
      '/dotfiles/harness/keybindings.jsonc',
    );
    expect(
      KeymapStore.legacyPath(environment: environment, isWindows: false),
      isNull,
    );
  });

  group('legacy migration', () {
    late File file;
    late File legacy;
    late String original;
    setUp(() async {
      file = File('${directory.path}/roaming/harness/keybindings.jsonc');
      legacy = File('${directory.path}/home/.config/harness/keybindings.jsonc');
      original = '// Keep this comment.\n${config('pane.focus_left')}';
      await legacy.parent.create(recursive: true);
      await legacy.writeAsString(original);
    });

    test('loads legacy rows without creating the new file', () async {
      final store = storeFor(file, legacyFile: legacy);
      addTearDown(store.dispose);
      await store.start();
      expect(selected(store), 'pane.focus_left');
      expect(store.hasOverrides, isTrue);
      expect(store.error, isNull);
      expect(await file.exists(), isFalse);
      expect(await legacy.readAsString(), original);
    });

    test(
      'first rebind keeps legacy rows and writes only the new file',
      () async {
        original = original.replaceAll('cmd+t', 'cmd+l');
        await legacy.writeAsString(original);
        final store = storeFor(file, legacyFile: legacy);
        addTearDown(store.dispose);
        await store.start();
        await store.editBindings(
          (custom, defaults) => rebindBindings(
            custom,
            defaults,
            command: 'swarm.new',
            context: KeymapContext.workspace,
            stroke: KeyStroke.parse('cmd+o'),
          ),
        );
        final saved = KeymapConfig.parse(
          await file.readAsString(),
          commands: {'swarm.new', 'pane.focus_left'},
        );
        expect(
          saved.bindings.any(
            (b) => b.sequence == 'cmd+l' && b.command == 'pane.focus_left',
          ),
          isTrue,
        );
        expect(
          saved.bindings.any(
            (b) => b.sequence == 'cmd+o' && b.command == 'swarm.new',
          ),
          isTrue,
        );
        expect(await legacy.readAsString(), original);
        expect(await File('${file.path}.bak').readAsString(), original);
      },
    );

    test('Edit keybindings opens a copy with original comments', () async {
      final store = storeFor(file, legacyFile: legacy);
      addTearDown(store.dispose);
      expect((await store.ensureFile()).path, file.path);
      expect(await file.readAsString(), original);
      expect(await legacy.readAsString(), original);
      expect(selected(store), 'pane.focus_left');
    });

    test('Edit keybindings copies malformed legacy bytes for repair', () async {
      final bytes = [0xff, 0xfe, 0x7b];
      await legacy.writeAsBytes(bytes);
      final store = storeFor(file, legacyFile: legacy);
      addTearDown(store.dispose);
      expect((await store.ensureFile()).path, file.path);
      expect(await file.readAsBytes(), bytes);
      expect(await legacy.readAsBytes(), bytes);
      expect(store.error, isNotNull);
    });

    test(
      'Edit keybindings preserves an oversized canonical file for repair',
      () async {
        await file.parent.create(recursive: true);
        final bytes = List.filled(KeymapStore.maximumBytes + 1, 32);
        await file.writeAsBytes(bytes);
        final store = storeFor(file, legacyFile: legacy);
        addTearDown(store.dispose);
        expect((await store.ensureFile()).path, file.path);
        expect(await file.readAsBytes(), bytes);
        expect(store.error, contains('128 KiB'));
      },
    );

    test('existing canonical file wins even when empty', () async {
      await file.parent.create(recursive: true);
      await file.writeAsString('');
      final store = storeFor(file, legacyFile: legacy);
      addTearDown(store.dispose);
      await store.start();
      expect(selected(store), 'swarm.new');
      expect(store.hasOverrides, isFalse);
    });

    test('reset backs up legacy and writes defaults to the new path', () async {
      final store = storeFor(file, legacyFile: legacy);
      addTearDown(store.dispose);
      await store.start();
      await store.resetAll();
      expect(await file.exists(), isTrue);
      expect(await File('${file.path}.bak').readAsString(), original);
      expect(selected(store), 'swarm.new');
      expect(store.hasOverrides, isFalse);
      expect(await legacy.readAsString(), original);
    });

    test(
      'watch follows legacy edits then a canonical file created later',
      () async {
        final store = storeFor(file, legacyFile: legacy, watch: true);
        addTearDown(store.dispose);
        await store.start();
        expect(selected(store), 'pane.focus_left');
        await legacy.writeAsString(config('swarm.new'));
        await eventually(() => selected(store) == 'swarm.new');
        await file.parent.create(recursive: true);
        await file.writeAsString(config('pane.focus_left'));
        await eventually(() => selected(store) == 'pane.focus_left');
        await legacy.writeAsString(config('swarm.new'));
        await store.reload();
        expect(selected(store), 'pane.focus_left');
        expect(store.error, isNull);
      },
    );
  });

  test('missing file uses defaults without creating a user config', () async {
    final file = File('${directory.path}/config/keybindings.jsonc');
    final store = storeFor(file);
    addTearDown(store.dispose);
    await store.start();
    expect(selected(store), 'swarm.new');
    expect(store.error, isNull);
    expect(await file.parent.exists(), false);
    expect(store.revision, 0);
  });

  test(
    'invalid edit retains working bindings; repair and removal recover',
    () async {
      final file = File('${directory.path}/keybindings.jsonc');
      final store = storeFor(file);
      addTearDown(store.dispose);
      var changes = 0;
      store.addListener(() => changes++);
      await file.writeAsString(config('pane.focus_left'));
      await store.start();
      expect(selected(store), 'pane.focus_left');
      final good = store.current;
      final revision = store.revision;
      await file.writeAsString('{');
      await store.reload();
      expect(store.current, same(good));
      expect(store.revision, revision);
      expect(store.error, contains('FormatException'));
      await file.writeAsString(
        '// comments only change\n${config('pane.focus_left')}',
      );
      await store.reload();
      expect(store.current, same(good));
      expect(store.error, isNull);
      expect(changes, 3); // New map, diagnostic, diagnostic cleared.
      await file.delete();
      await store.reload();
      expect(selected(store), 'swarm.new');
    },
  );

  test('a slower old read cannot overwrite a newer map or error', () async {
    final file = _ControlledFile();
    final store = storeFor(file);
    addTearDown(store.dispose);
    final first = store.reload();
    final second = store.reload();
    file.reads[1].add(utf8.encode(config('pane.focus_left')));
    await file.reads[1].close();
    await second;
    file.reads[0].add(utf8.encode('{'));
    await file.reads[0].close();
    await first;
    expect(selected(store), 'pane.focus_left');
    expect(store.error, isNull);
  });

  test('oversized and malformed UTF-8 files retain the current map', () async {
    final file = File('${directory.path}/keybindings.jsonc');
    final store = storeFor(file);
    addTearDown(store.dispose);
    await store.start();
    final good = store.current;
    await file.writeAsBytes(List.filled(KeymapStore.maximumBytes + 1, 32));
    await store.reload();
    expect(store.error, contains('128 KiB'));
    expect(store.current, same(good));
    await file.writeAsBytes([0xff]);
    await store.reload();
    expect(store.error, isNotNull);
    expect(store.current, same(good));
  });

  test(
    'explicit open creates a template and preserves existing file contents',
    () async {
      final file = File('${directory.path}/config/keybindings.jsonc');
      final store = storeFor(file);
      addTearDown(store.dispose);
      await store.ensureFile();
      expect(await file.readAsString(), contains('Defaults are inherited'));
      final customized = config('pane.focus_left');
      await file.writeAsString(customized);
      await store.ensureFile();
      expect(await file.readAsString(), customized);
      expect(selected(store), 'pane.focus_left');
    },
  );

  test(
    'watch discovers a new directory and an editor atomic replacement',
    () async {
      final file = File('${directory.path}/config/keybindings.jsonc');
      final store = storeFor(file, watch: true);
      addTearDown(store.dispose);
      await store.start();
      await file.parent.create();
      await file.writeAsString(config('pane.focus_left'));
      await eventually(() => selected(store) == 'pane.focus_left');
      final replacement = File('${file.path}.save');
      await replacement.writeAsString(config('swarm.new'));
      await replacement.rename(file.path);
      await eventually(() => selected(store) == 'swarm.new');
      expect(store.error, isNull);
    },
  );

  test(
    'watch follows a dotfiles symlink and its replacement target',
    () async {
      final first = File('${directory.path}/repo1/keys.jsonc');
      final second = File('${directory.path}/repo2/keys.jsonc');
      await first.parent.create();
      await second.parent.create();
      await first.writeAsString(config('swarm.new'));
      await second.writeAsString(config('pane.focus_left'));
      final link = Link('${directory.path}/app/keybindings.jsonc');
      await Directory('${directory.path}/app').create();
      await link.create(first.path);
      final store = storeFor(File(link.path), watch: true);
      addTearDown(store.dispose);
      await store.start();
      await link.update(second.path);
      await eventually(() => selected(store) == 'pane.focus_left');
      final replacement = File('${second.path}.save');
      await replacement.writeAsString(config('swarm.new'));
      await replacement.rename(second.path);
      await eventually(() => selected(store) == 'swarm.new');
    },
    skip: Platform.isWindows
        ? 'Creating Windows symlinks requires host permission'
        : false,
  );

  test('configuration path follows XDG and rejects a relative XDG root', () {
    expect(
      KeymapStore.defaultPath(environment: {'HOME': '/users/dev'}),
      '/users/dev/.config/harness/keybindings.jsonc',
    );
    expect(
      KeymapStore.defaultPath(
        environment: {'HOME': '/users/dev', 'XDG_CONFIG_HOME': '/dotfiles'},
      ),
      '/dotfiles/harness/keybindings.jsonc',
    );
    expect(
      KeymapStore.defaultPath(
        environment: {'HOME': '/users/dev', 'XDG_CONFIG_HOME': 'relative'},
      ),
      '/users/dev/.config/harness/keybindings.jsonc',
    );
  });

  test(
    'an immediate save to a newly selected symlink target is not lost',
    () async {
      final first = File('${directory.path}/repo1/keys.jsonc');
      final second = File('${directory.path}/repo2/keys.jsonc');
      await first.parent.create();
      await second.parent.create();
      await first.writeAsString(config('swarm.new'));
      await second.writeAsString(config('pane.focus_left'));
      final replacement = File('${second.path}.save');
      await replacement.writeAsString(config('swarm.new'));
      final link = Link('${directory.path}/app/keybindings.jsonc');
      await Directory('${directory.path}/app').create();
      await link.create(first.path);
      final watchedFile = _PausedResolutionFile(File(link.path));
      final store = storeFor(watchedFile, watch: true);
      addTearDown(store.dispose);
      await store.start();
      var replaced = false;
      final replacementDelivered = Completer<void>();
      final replacementPaths = {
        second.path,
        await second.resolveSymbolicLinks(),
      };
      final witness = second.parent.watch().listen((event) {
        if (replaced &&
            (replacementPaths.contains(event.path) ||
                event is FileSystemMoveEvent &&
                    replacementPaths.contains(event.destination)) &&
            !replacementDelivered.isCompleted) {
          replacementDelivered.complete();
        }
      });
      addTearDown(witness.cancel);
      final gate = Completer<void>();
      store.addListener(() {
        if (!replaced && selected(store) == 'pane.focus_left') {
          // The editor saves again as soon as the new target's map is visible.
          // Hold the next watch refresh until the filesystem delivered this
          // replacement. A slow target discovery must not lose an editor save.
          watchedFile.resolutionGate = gate;
          replacement.renameSync(second.path);
          replaced = true;
        }
      });
      await link.update(second.path);
      try {
        await Future.wait([
          watchedFile.resolutionPaused.future,
          replacementDelivered.future,
        ]).timeout(const Duration(seconds: 5));
      } finally {
        gate.complete();
      }
      await eventually(() => replaced && selected(store) == 'swarm.new');
      expect(store.error, isNull);
    },
    skip: Platform.isWindows
        ? 'Creating Windows symlinks requires host permission'
        : false,
  );
}
