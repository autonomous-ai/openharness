import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/hub_return.dart';
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
  test(
    'refuses a missing viewer and oversized projects without publishing',
    () async {
      await file('code.py', 'print(1)');
      await expectLater(
        buildPublicationDraft(
          folder: root.path,
          title: 'Test',
          engine: 'codex',
        ),
        throwsFormatException,
      );
      await file('index.html', '<p>Ready</p>');
      await file('large.json', 'x' * 3000001);
      await expectLater(
        buildPublicationDraft(
          folder: root.path,
          title: 'Test',
          engine: 'codex',
        ),
        throwsFormatException,
      );
    },
  );
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
