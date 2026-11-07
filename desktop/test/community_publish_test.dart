import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/hub_return.dart';
import 'package:harness/community/publish_conversation.dart';
import 'package:harness/community/publish_files.dart';
import 'package:harness/community/publish_project.dart';

void main() {
  late Directory root;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('hub-publish-test-');
  });
  tearDown(() => root.delete(recursive: true));
  Future<File> file(String name, String content) async {
    final f = File('${root.path}/$name');
    await f.parent.create(recursive: true);
    return f.writeAsString(content);
  }

  test('publishes current files and reviewed context while keeping fork attribution', () async {
    await file('preview.html', '<h1>My new version</h1>');
    await file(
      'OPEN-HARNESS.json',
      jsonEncode({
        'description': 'A lamp',
        'forkedFrom': 'starter-ribbon-lamp',
        'files': [
          {'path': 'preview.html', 'content': 'old version'},
        ],
      }),
    );
    await file('scenes/hello.py', 'print("new geometry")');
    await file('.env', 'not shared');
    await file('node_modules/dependency/index.js', 'not shared');
    await file('AGENTS.md', 'private instructions');
    await File('${root.path}/out.glb').writeAsBytes([1, 2, 3]);
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'My lamp',
      engine: 'codex',
      harnessId: 'autonomous/blender',
      tail: {
        'rows': [
          {'ask': 'Make it blue', 'answer': 'Done'},
        ],
        'hasMore': true,
      },
    );
    final files = draft['files'] as List;
    expect(files.map((f) => f['path']), [
      'out.glb',
      'preview.html',
      'scenes/hello.py',
    ]);
    expect(files[1]['content'], '<h1>My new version</h1>');
    expect(base64Decode(files[0]['content']), [1, 2, 3]);
    expect(draft['forkedFrom'], 'starter-ribbon-lamp');
    expect(draft['conversation'], [
      {'role': 'user', 'text': 'Make it blue'},
      {'role': 'assistant', 'text': 'Done'},
    ]);
    expect(draft['contextNote'], contains('Recent conversation'));
    expect(draft, isNot(contains('sessionId')));
  });
  test('never follows source symlinks outside the selected project', () async {
    final secret = await file('.private/key.json', 'private');
    await file('preview.html', '<p>Public</p>');
    await Link('${root.path}/leak.json').create(secret.path);
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'Safe',
      engine: 'codex',
    );
    expect((draft['files'] as List).map((f) => f['path']), ['preview.html']);
  }, skip: Platform.isWindows);
  test('asks for a preview.html, naming what an app page loads that the Hub cannot', () async {
    await file('code.py', 'print(1)');
    await file(
      'index.html',
      '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
    );
    Future<Map<String, dynamic>> build() => buildPublicationDraft(
      folder: root.path,
      title: 'Test',
      engine: 'codex',
    );
    await expectLater(
      build(),
      throwsA(
        isA<NeedsOutput>().having(
          (e) => e.message,
          'message',
          allOf(
            contains('index.html loads app.js, style.css'),
            contains('preview.html'),
          ),
        ),
      ),
    );
    await file('preview.html', 'x' * 3000001);
    await expectLater(build(), throwsFormatException);
  });
  test('asks for a preview.html when the project has no page at all', () async {
    await file('code.py', 'print(1)');
    await expectLater(
      buildPublicationDraft(folder: root.path, title: 'Test', engine: 'codex'),
      throwsA(
        isA<NeedsOutput>().having(
          (e) => e.message,
          'message',
          contains('The Hub shows what a session made'),
        ),
      ),
    );
  });
  test('a one-file game is the output under any top-level name', () async {
    const game =
        '<canvas id="c"></canvas><style>body{background:url(data:image/png;base64,AA==)}</style>'
        '<script>requestAnimationFrame(function loop(){requestAnimationFrame(loop)})</script>';
    await file('src/nested.html', '<p>Not at the top</p>');
    await file('game.html', '<script src="engine.js"></script>');
    await file('snake.html', game);
    Future<Map<String, dynamic>> build() => buildPublicationDraft(
      folder: root.path,
      title: 'Snake',
      engine: 'claude',
    );
    expect((await build())['viewerPath'], 'snake.html');
    await file('index.html', game);
    expect((await build())['viewerPath'], 'index.html');
    await file('preview.html', '<h1>Made for the Hub</h1>');
    expect((await build())['viewerPath'], 'preview.html');
  });
  test('a game in a folder of its own is the output', () async {
    const game = '<canvas></canvas><script>start()</script>';
    await file('docs/guide.html', '<p>Not an output</p>');
    await file('tank-1987/index.html', game);
    await file('tank-1987/levels/index.html', game);
    Future<Map<String, dynamic>> build() => buildPublicationDraft(
      folder: root.path,
      title: 'Tank',
      engine: 'codex',
    );
    expect((await build())['viewerPath'], 'tank-1987/index.html');
    await file('notes.html', game);
    expect((await build())['viewerPath'], 'notes.html');
  });
  test(
    'a one-file page that imports a module from a CDN is never assumed',
    () async {
      await file(
        'twisted-ribbon-lamp.html',
        '<canvas></canvas><script type="module">import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";</script>',
      );
      await expectLater(
        buildPublicationDraft(
          folder: root.path,
          title: 'Lamp',
          engine: 'codex',
        ),
        throwsA(
          isA<NeedsOutput>().having(
            (e) => e.message,
            'message',
            contains(
              'twisted-ribbon-lamp.html loads https://cdn.jsdelivr.net/',
            ),
          ),
        ),
      );
    },
  );
  test(
    'a folder\'s index.html that needs other files is never assumed',
    () async {
      await file('app/index.html', '<script src="main.js"></script>');
      await expectLater(
        buildPublicationDraft(folder: root.path, title: 'App', engine: 'codex'),
        throwsA(
          isA<NeedsOutput>().having(
            (e) => e.message,
            'message',
            contains('app/index.html loads main.js'),
          ),
        ),
      );
    },
  );
  test('passes over a fork\'s unchanged top-level page', () async {
    const original = '<h1>Original game</h1>';
    await file('index.html', original);
    await file(
      'OPEN-HARNESS.json',
      jsonEncode({
        'files': [
          {'path': 'index.html', 'content': original},
        ],
      }),
    );
    await expectLater(
      buildPublicationDraft(folder: root.path, title: 'Fork', engine: 'codex'),
      throwsA(
        isA<NeedsOutput>().having(
          (e) => e.message,
          'message',
          contains('index.html is still the original'),
        ),
      ),
    );
  });
  test('a fork keeps the page it was published with', () async {
    await file('index.html', '<h1>Moonlight</h1>');
    await file(
      'OPEN-HARNESS.json',
      jsonEncode({
        'forkedFrom': 'starter-moonlight',
        'viewerPath': 'index.html',
      }),
    );
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'My moonlight',
      engine: 'codex',
    );
    expect(draft['viewerPath'], 'index.html');
    expect(draft['forkedFrom'], 'starter-moonlight');
  });
  test('refuses a fork whose output is still the original', () async {
    const poster = '<img src="data:image/png;base64,AA==">';
    await file('preview.html', poster);
    await file('main.typ', '= My changes');
    await file(
      'OPEN-HARNESS.json',
      jsonEncode({
        'forkedFrom': 'starter-portable-light',
        'viewerPath': 'preview.html',
        'files': [
          {'path': 'preview.html', 'content': poster},
          {'path': 'main.typ', 'content': '= Original'},
        ],
      }),
    );
    Future<Map<String, dynamic>> build() => buildPublicationDraft(
      folder: root.path,
      title: 'Mine',
      engine: 'codex',
    );
    await expectLater(
      build(),
      throwsA(
        isA<NeedsOutput>().having(
          (e) => e.message,
          'message',
          contains('preview.html is still the original'),
        ),
      ),
    );
    await file('preview.html', '<h1>My page</h1>');
    expect((await build())['viewerPath'], 'preview.html');
  });
  test(
    'shows a picture of the viewer when the project has no page of its own',
    () async {
      const poster = '<img src="data:image/png;base64,AA==">';
      await file('preview.html', poster);
      await file('main.typ', '= My changes');
      await file(
        'OPEN-HARNESS.json',
        jsonEncode({
          'viewerPath': 'preview.html',
          'files': [
            {'path': 'preview.html', 'content': poster},
          ],
        }),
      );
      final draft = await buildPublicationDraft(
        folder: root.path,
        title: 'Light that travels',
        engine: 'codex',
        harnessId: 'autonomous/typst',
        viewerPicture: 'SNAPSHOT',
      );
      final files = draft['files'] as List;
      final output = files.firstWhere((f) => f['path'] == 'preview.html');
      expect(output['content'], contains('data:image/jpeg;base64,SNAPSHOT'));
      expect(files.where((f) => f['path'] == 'preview.html'), hasLength(1));
      expect(draft['cover'], 'data:image/jpeg;base64,SNAPSHOT');
      expect(draft['harnessId'], 'autonomous/typst');
      expect(
        draft['contextNote'],
        contains('a picture of your viewer. A fork opens the viewer itself.'),
      );

      await file('preview.html', '<h1>My own page</h1>');
      final own = await buildPublicationDraft(
        folder: root.path,
        title: 'Light that travels',
        engine: 'codex',
        viewerPicture: 'SNAPSHOT',
      );
      expect(
        (own['files'] as List).firstWhere(
          (f) => f['path'] == 'preview.html',
        )['content'],
        '<h1>My own page</h1>',
      );
      expect(own['contextNote'], isNot(contains('a picture of your viewer')));
    },
  );
  test(
    'passes over an unchanged original page to the new preview.html',
    () async {
      const original = '<h1>Moonlight</h1>';
      await file('index.html', original);
      await file('preview.html', '<h1>My review</h1>');
      await file(
        'OPEN-HARNESS.json',
        jsonEncode({
          'viewerPath': 'index.html',
          'files': [
            {'path': 'index.html', 'content': original},
          ],
        }),
      );
      final draft = await buildPublicationDraft(
        folder: root.path,
        title: 'Mine',
        engine: 'codex',
        viewerPicture: 'SNAPSHOT',
      );
      expect(draft['viewerPath'], 'preview.html');
      expect(
        (draft['files'] as List).firstWhere(
          (f) => f['path'] == 'preview.html',
        )['content'],
        '<h1>My review</h1>',
      );
      expect(draft, isNot(contains('cover')));
    },
  );
  test('leaves out what does not fit and names it, keeping the output and the harness source', () async {
    await file('preview.html', '<p>Ready</p>');
    await file('sim/hello.py', 'print("marker")');
    for (var i = 0; i < 40; i++) {
      await file('src/deep/part$i.ts', 'export const n = $i');
    }
    await file('large.json', 'x' * 3000001);
    await File('${root.path}/latin1.csv')
        .writeAsBytes([0x63, 0x61, 0x66, 0xe9]);
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'Robot',
      engine: 'codex',
      harnessId: 'autonomous/mujoco',
    );
    final paths = (draft['files'] as List).map((f) => f['path']).toList();
    expect(paths, hasLength(30));
    expect(paths, containsAll(['preview.html', 'sim/hello.py']));
    expect(paths, isNot(contains('large.json')));
    expect(paths, isNot(contains('latin1.csv')));
    expect(draft['viewerPath'], 'preview.html');
    expect(draft['harnessId'], 'autonomous/mujoco');
    expect(
      draft['contextNote'],
      contains('Left out large.json, latin1.csv, src/deep/'),
    );
    expect(draft['contextNote'], contains('and 11 more'));
  });
  test('publishes without a harness whose source is missing, and asks for an unknown agent', () async {
    await file('preview.html', '<p>Ready</p>');
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'Lamp',
      engine: 'grok',
      harnessId: 'autonomous/blender',
    );
    expect(draft, isNot(contains('harnessId')));
    expect(draft, isNot(contains('engine')));
    expect(draft['contextNote'], contains('Without scenes/hello.py'));
    expect(draft['contextNote'], contains('does not list grok'));
  });
  test('keeps the newest turns of a long session', () async {
    final rows = [
      for (var i = 0; i < 50; i++) {'ask': 'ask $i', 'answer': 'answer $i'},
    ];
    final turns = publicationTurns({'rows': rows});
    expect(turns, hasLength(80));
    expect(turns.first, {'role': 'user', 'text': 'ask 10'});
    expect(turns.last, {'role': 'assistant', 'text': 'answer 49'});
    final long = publicationTurns({
      'rows': [
        {'ask': 'x' * 25000},
      ],
    });
    expect(long.map((turn) => turn['text']!.length), [12000, 12000, 1000]);
  });
  test('one-use browser handoff posts a draft only to the configured Hub', () async {
    final draft = {
      'version': 1,
      'files': [],
      'title': '</textarea><script>bad()</script>',
    };
    final handoff = await PublicationHandoff.start(draft);
    final client = HttpClient();
    addTearDown(() {
      client.close(force: true);
    });
    final wrong = await (await client.getUrl(
      handoff.url.replace(path: '/wrong'),
    )).close();
    expect(wrong.statusCode, 404);
    await wrong.drain<void>();
    final response = await (await client.getUrl(handoff.url)).close();
    final html = await utf8.decoder.bind(response).join();
    expect(response.statusCode, 200);
    expect(response.headers.value('cache-control'), 'no-store');
    expect(
      html,
      contains(
        'action="${const HtmlEscape().convert('https://harness.autonomous.ai/hub/import')}"',
      ),
    );
    expect(html, isNot(contains('<script>bad()')));
    expect(html, isNot(contains('/api/community/harnesses')));
    // The draft goes as a gzipped file, never as text the edge could read.
    expect(html, contains('<input type="file" name="draft" hidden>'));
    final packed = RegExp(r'atob\("([A-Za-z0-9+/=]+)"\)').firstMatch(html)![1]!;
    expect(jsonDecode(utf8.decode(gzip.decode(base64Decode(packed)))), draft);
    await handoff.close();
  });
  test('login return accepts only local Hub pages', () {
    expect(hubReturnPath('/hub/publish?draft=abc'), '/hub/publish?draft=abc');
    for (final bad in [
      'https://evil.test/hub',
      '//evil.test/hub',
      '/hub/../auth',
      '/hub/%2e%2e/auth',
      '/hub\\evil',
      '/other',
      '/hub#token',
    ]) {
      expect(hubReturnPath(bad), isNull, reason: bad);
    }
  });
}
