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
  test(
    'asks for a preview.html, never assuming an app page is the output',
    () async {
      await file('code.py', 'print(1)');
      await file('index.html', '<script src="app.js"></script>');
      Future<Map<String, dynamic>> build() => buildPublicationDraft(
        folder: root.path,
        title: 'Test',
        engine: 'codex',
      );
      await expectLater(
        build(),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('preview.html'),
          ),
        ),
      );
      await file('preview.html', 'x' * 3000001);
      await expectLater(build(), throwsFormatException);
    },
  );
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
      expect(draft['contextNote'], contains('a picture of your viewer'));

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
    expect(html, contains(const HtmlEscape().convert('</textarea>')));
    expect(html, isNot(contains('<script>bad()')));
    expect(html, isNot(contains('/api/community/harnesses')));
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
