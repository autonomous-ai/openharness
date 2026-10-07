import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/hub_return.dart';
import 'package:harness/community/publish_conversation.dart';
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
    await file('index.html', '<p>Public</p>');
    await Link('${root.path}/leak.json').create(secret.path);
    final draft = await buildPublicationDraft(
      folder: root.path,
      title: 'Safe',
      engine: 'codex',
    );
    expect((draft['files'] as List).map((f) => f['path']), ['index.html']);
  }, skip: Platform.isWindows);
  test('refuses only a missing or oversized viewer', () async {
    await file('code.py', 'print(1)');
    Future<Map<String, dynamic>> build() => buildPublicationDraft(
      folder: root.path,
      title: 'Test',
      engine: 'codex',
    );
    await expectLater(build(), throwsFormatException);
    await file('index.html', 'x' * 3000001);
    await expectLater(build(), throwsFormatException);
  });
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
    await file('index.html', '<p>Ready</p>');
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
