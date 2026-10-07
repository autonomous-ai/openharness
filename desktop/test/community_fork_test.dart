import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/fork_link.dart';
import 'package:harness/community/fork_inbox.dart';
import 'package:harness/community/fork_project.dart';
import 'package:harness/community/fork_controller.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/state/app_state.dart';

import 'support/model_manager.dart';

class MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

const link = ForkLink(
  'starter-moonlight',
  '11111111-1111-4111-8111-111111111111',
);
Map<String, dynamic> snapshot() => {
  'id': link.harnessId,
  'title': 'Moonlight',
  'authorName': 'Harness',
  'engine': 'Codex',
  'viewerPath': 'index.html',
  'files': [
    {'path': 'index.html', 'content': '<h1>Hello</h1>'},
  ],
  'conversation': [
    {'role': 'user', 'text': 'Make a game.'},
  ],
};

class FakeImporter extends ForkProjectImporter {
  FakeImporter() : super(root: Directory('/not-used'));
  int installs = 0;
  final viewerInstalls = <String>[];
  final checkedViewers = <String?>[];
  String? runtimeError;
  String folder = '/fixture/community';
  String? legacyFolder;
  Completer<void>? hold;
  Completer<void>? holdViewerInstall;
  @override
  Future<ForkProject> prepare(ForkLink link) async {
    await hold?.future;
    return ForkProject(
      folder: folder,
      package: '/fixture/package',
      title: 'Moonlight',
      engine: 'codex',
      dsh: 'forks/test',
      legacyFolder: legacyFolder,
    );
  }

  @override
  Future<void> install(ForkProject project) async {
    installs++;
  }

  @override
  Future<void> installViewer(String id) async {
    viewerInstalls.add(id);
    await holdViewerInstall?.future;
  }

  @override
  Future<void> checkRuntime(ForkProject project, {String? viewerId}) async {
    checkedViewers.add(viewerId);
    if (runtimeError != null) throw FormatException(runtimeError!);
  }
}

class ForkConnection extends ModelManagerConnection {
  String? viewerUrl = 'http://127.0.0.1:4179/';
  String? viewerError;
  final created = Completer<void>();
  Map<String, dynamic> frame() => {
    'id': 'manager',
    'engine': 'codex',
    'dsh': 'forks/test',
    'terminal': {'available': true},
    'viewerUrl': viewerUrl,
    'viewerError': viewerError,
    'viewerName': 'Moonlight',
    'project': {'name': 'Moonlight', 'cwd': '/fixture/community'},
  };

  Future<void> sync(ForkTestApp app) => app.handleEventForTest('m', {
    'type': 'agent_synced',
    'payload': {'agent': frame()},
  });

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final result = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    if (result['agent'] case final Map<String, dynamic> agent) {
      if (!created.isCompleted) created.complete();
      return {
        ...result,
        'agent': {...agent, ...frame()},
      };
    }
    return result;
  }
}

class ForkTestApp extends ModelManagerTestApp {
  ForkTestApp(super.connection);
  String? viewerUse;
  bool viewerInstalled = false;
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    stateOf(machineId)!.dsh.replace([
      DshEntry(
        id: 'forks/test',
        name: 'Moonlight',
        engine: 'codex',
        description: '',
        installed: true,
        viewer: true,
        viewerUse: viewerUse,
      ),
      if (viewerUse != null)
        DshEntry(
          id: viewerUse!,
          name: '3D Viewer',
          engine: '',
          kind: 'viewer',
          installed: viewerInstalled,
        ),
    ]);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('links contain only public IDs and one retry receipt', () {
    expect(ForkLink.parse(link.url)?.key, link.key);
    for (final url in [
      'https://fork/x',
      'harness://fork/../private?request=${link.requestId}',
      '${link.url}&url=https://evil.test',
      '${link.url}&request=${link.requestId}',
      '${link.url}#x',
      'harness://user@fork/${link.harnessId}?request=${link.requestId}',
      'harness://fork:80/${link.harnessId}?request=${link.requestId}',
    ]) {
      expect(ForkLink.parse(url), isNull, reason: url);
    }
  });
  test(
    'cold links persist through login/restart and duplicate delivery',
    () async {
      const channel = MethodChannel('harness/community_links');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async => [link.url]);
      final store = MemoryStore(), inbox = ForkInbox(MemoryStore());
      await inbox.initialize();
      expect(inbox.pending.single.key, link.key);
      final first = ForkInbox(store);
      await first.initialize();
      await Future.wait([first.accept(link.url), first.accept(link.url)]);
      expect(first.pending, hasLength(1));
      final restored = ForkInbox(store);
      await restored.initialize();
      expect(restored.pending, hasLength(1));
      await restored.complete(link);
      await restored.accept(link.url);
      expect(restored.pending, hasLength(1));
      messenger.setMockMethodCallHandler(channel, null);
      inbox.dispose();
      first.dispose();
      restored.dispose();
    },
  );
  test('snapshot rejects traversal, instruction injection and collisions', () {
    for (final path in [
      '../outside',
      '/absolute',
      'a/../../b',
      'AGENTS.md',
      'src/CLAUDE.md',
      'src/.env',
      'src//x',
      'CON',
    ]) {
      final data = snapshot();
      data['files'] = [
        {'path': path, 'content': 'bad'},
      ];
      expect(
        () => ForkProjectImporter.validate(data, link),
        throwsFormatException,
        reason: path,
      );
    }
    final collision = snapshot();
    (collision['files'] as List).add({
      'path': 'INDEX.html/x',
      'content': 'bad',
    });
    expect(
      () => ForkProjectImporter.validate(collision, link),
      throwsFormatException,
    );
    final arbitrary = snapshot()..['harnessId'] = 'evil/run';
    expect(
      () => ForkProjectImporter.validate(arbitrary, link),
      throwsFormatException,
    );
  });
  test('native binary artifacts survive transport', () {
    final data = snapshot();
    (data['files'] as List).add({
      'path': 'out/model.glb',
      'content': 'Z2xURg==',
      'encoding': 'base64',
    });
    expect(ForkProjectImporter.validate(data, link)['out/model.glb'], [
      103,
      108,
      84,
      70,
    ]);
  });
  test(
    'real HTTP import is atomic and retries preserve edits and context',
    () async {
      final root = await Directory.systemTemp.createTemp('community-fork-test');
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var reads = 0;
      server.listen((request) async {
        reads++;
        expect(request.uri.path, '/hub/${link.harnessId}/snapshot');
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({'version': 1, 'harness': snapshot()}),
        );
        await request.response.close();
      });
      try {
        final importer = ForkProjectImporter(
          root: Directory('${root.path}/metadata'),
          projectsRoot: Directory('${root.path}/harnesses'),
          origin: 'http://127.0.0.1:${server.port}',
        );
        final first = await importer.prepare(link);
        expect(first.folder, '${root.path}/harnesses/moonlight');
        expect(
          await File('${first.folder}/SESSION.md').readAsString(),
          contains('Make a game.'),
        );
        expect(
          await File('${first.folder}/LICENSE').readAsString(),
          contains('MIT License'),
        );
        final manifest = jsonDecode(
          await File('${first.package}/harness.json').readAsString(),
        );
        expect(manifest['toolchain'], isNull);
        expect(manifest['viewer']['use'], 'autonomous/web-viewer');
        await File('${first.folder}/index.html').writeAsString('my changes');
        final second = await importer.prepare(link);
        expect(second.folder, first.folder);
        expect(reads, 1);
        expect(
          await File('${first.folder}/index.html').readAsString(),
          'my changes',
        );
      } finally {
        await server.close(force: true);
        await root.delete(recursive: true);
      }
    },
  );
  test('concurrent fork clicks and lost replies create once, with normal permissions', () async {
    final connection = ForkConnection()..loseFirstReply = true;
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final importer = FakeImporter();
    final controller = ForkController(app, importer, MemoryStore());
    try {
      final first = controller.open(link), second = controller.open(link);
      expect(identical(first, second), isTrue);
      expect(await first, isFalse);
      expect(await controller.open(link), isTrue);
      expect(connection.creations, hasLength(1));
      final request = connection.creations.single;
      expect(request['creationId'], link.requestId.replaceAll('-', ''));
      expect(request['bypassPermission'], false);
      expect(request['permissionMode'], 'ask');
      expect(request['prompt'], isNull);
      expect(request['cwd'], '/fixture/community');
      expect(importer.installs, 0);
      expect(app.panes.map((p) => p.isWeb), [true, false]);
      expect(app.activeSwarm.paneSizes['2:manual']!.tiles.first.width, .7);
      final forkTab = app.activeSwarmId;
      app.newSwarm(name: 'Other work');
      final count = app.swarms.length;
      expect(await controller.open(link), isTrue);
      expect(app.activeSwarmId, forkTab);
      expect(app.swarms, hasLength(count));
      expect(connection.creations, hasLength(1));
      // Relocation keeps the running agent's old cwd as an alias. Reopening
      // must find that conversation rather than launch a second one.
      importer
        ..legacyFolder = importer.folder
        ..folder = '/fixture/harnesses/moonlight';
      expect(await controller.open(link), isTrue);
      expect(connection.creations, hasLength(1));
      expect(app.activeSwarmId, forkTab);
    } finally {
      controller.dispose();
      app.dispose();
    }
  });
  test('signing out while importing cannot create a session', () async {
    final connection = ModelManagerConnection(),
        importer = FakeImporter()..hold = Completer<void>();
    final app = ModelManagerTestApp(connection)
      ..status = AppStatus.authenticated;
    final controller = ForkController(app, importer, MemoryStore());
    final result = controller.open(link);
    app.status = AppStatus.unauthenticated;
    importer.hold!.complete();
    expect(await result, isFalse);
    expect(connection.creations, isEmpty);
    controller.dispose();
    app.dispose();
  });

  test(
    'installed harness repairs its missing shared viewer before creating chat',
    () async {
      final connection = ForkConnection();
      final app = ForkTestApp(connection)
        ..status = AppStatus.authenticated
        ..viewerUse = 'autonomous/model-viewer';
      final importer = FakeImporter()..holdViewerInstall = Completer<void>();
      final controller = ForkController(app, importer, MemoryStore());
      addTearDown(controller.dispose);
      addTearDown(app.dispose);
      final opening = controller.open(link);
      await Future<void>.delayed(Duration.zero);
      expect(importer.viewerInstalls, ['autonomous/model-viewer']);
      expect(importer.installs, 0, reason: 'Preserve the installed parent.');
      expect(connection.creations, isEmpty);
      app.viewerInstalled = true;
      importer.holdViewerInstall!.complete();
      expect(await opening, isTrue);
      expect(importer.checkedViewers, ['autonomous/model-viewer']);
      expect(app.panes.map((p) => p.isWeb), [true, false]);
    },
  );

  test('a failed doctor prevents launch and stays retryable', () async {
    final connection = ForkConnection();
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final importer = FakeImporter()
      ..runtimeError = 'The viewer needs its tools.';
    final controller = ForkController(app, importer, MemoryStore());
    addTearDown(controller.dispose);
    addTearDown(app.dispose);
    expect(await controller.open(link), isFalse);
    expect(controller.error, importer.runtimeError);
    expect(connection.creations, isEmpty);
    importer.runtimeError = null;
    expect(await controller.open(link), isTrue);
    expect(connection.creations, hasLength(1));
  });

  test('creation is pending until its delayed viewer arrives', () async {
    final connection = ForkConnection()..viewerUrl = null;
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final controller = ForkController(app, FakeImporter(), MemoryStore());
    addTearDown(controller.dispose);
    addTearDown(app.dispose);
    var finished = false;
    final opening = controller.open(link)..then((_) => finished = true);
    await connection.created.future;
    await Future<void>.delayed(Duration.zero);
    expect(finished, isFalse);
    expect(controller.busy, isTrue);
    connection.viewerUrl = 'http://127.0.0.1:4179/';
    await connection.sync(app);
    expect(await opening, isTrue);
    expect(app.panes.map((p) => p.isWeb), [true, false]);
    expect(app.activeSwarm.paneSizes['2:manual']!.tiles.first.width, .7);
  });

  test('missing viewer times out; retry repairs and reuses the existing conversation', () async {
    final connection = ForkConnection()..viewerUrl = null;
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final importer = FakeImporter();
    final controller = ForkController(
      app,
      importer,
      MemoryStore(),
      viewerTimeout: const Duration(milliseconds: 20),
    );
    addTearDown(controller.dispose);
    addTearDown(app.dispose);
    expect(await controller.open(link), isFalse);
    expect(controller.error, contains('viewer is not ready'));
    final firstTab = app.activeSwarmId;
    app.viewerUse = 'autonomous/model-viewer';
    final retry = controller.open(link);
    await Future<void>.delayed(Duration.zero);
    connection.viewerUrl = 'http://127.0.0.1:4179/';
    await connection.sync(app);
    expect(await retry, isTrue);
    expect(importer.viewerInstalls, ['autonomous/model-viewer']);
    expect(connection.creations, hasLength(1));
    expect(app.activeSwarmId, firstTab);
  });

  test('viewer errors are not treated as a successful fork', () async {
    final connection = ForkConnection()
      ..viewerUrl = null
      ..viewerError = 'Viewer could not start';
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final controller = ForkController(app, FakeImporter(), MemoryStore());
    addTearDown(controller.dispose);
    addTearDown(app.dispose);
    expect(await controller.open(link), isFalse);
    expect(controller.error, contains('viewer could not open'));
    expect(connection.creations, hasLength(1));
  });

  test('disposing while the viewer starts cancels the pending open', () async {
    final connection = ForkConnection()..viewerUrl = null;
    final app = ForkTestApp(connection)..status = AppStatus.authenticated;
    final controller = ForkController(app, FakeImporter(), MemoryStore());
    final opening = controller.open(link);
    await connection.created.future;
    await Future<void>.delayed(Duration.zero);
    controller.dispose();
    expect(await opening, isFalse);
    app.dispose();
  });

  test('runtime checks include the shared viewer and installs reject unknown sources', () async {
    final commands = <List<String>>[];
    final cli = HarnessCliRunner(
      harnessHome: Directory('/fixture/harness'),
      environment: const {},
      runProcess: (executable, arguments, {environment}) async {
        commands.add(arguments);
        return ProcessResult(
          0,
          arguments.last == 'autonomous/model-viewer' &&
                  arguments.contains('doctor')
              ? 1
              : 0,
          '',
          '',
        );
      },
    );
    final importer = ForkProjectImporter(cli: cli);
    await importer.installViewer('autonomous/model-viewer');
    const project = ForkProject(
      folder: '/fixture/project',
      package: '',
      title: 'Blender',
      engine: 'codex',
      dsh: 'autonomous/blender',
    );
    await expectLater(
      importer.checkRuntime(project, viewerId: 'autonomous/model-viewer'),
      throwsFormatException,
    );
    expect(commands, [
      ['dsh', 'install', 'autonomous/model-viewer'],
      ['dsh', 'doctor', 'autonomous/blender'],
      ['dsh', 'doctor', 'autonomous/model-viewer'],
    ]);
    await expectLater(
      importer.installViewer('third-party/viewer'),
      throwsFormatException,
    );
    expect(commands, hasLength(3));
  });
}
