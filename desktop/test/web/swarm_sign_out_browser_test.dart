@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:web/web.dart' as web;

// The web's sign-out in a real browser's storage (the follow-up of #2306):
// what the page keeps of an account's Swarms goes from localStorage, another
// account's and the page's own settings stay.
void main() {
  const prefix = 'harness.web.v1.';
  const reading = SuperTabReading(
    quietPoll: Duration(seconds: 15),
    pausesAway: true,
    readsOnConnect: true,
    connectGrace: Duration(seconds: 10),
    messagesWithState: true,
    drawsSaved: true,
  );
  final clients = <SuperTabClient>[];
  SuperTabClient client() {
    final made = SuperTabClient(
      transport: (method, path, {body}) async => throw UnimplementedError(),
      storage: HarnessFileStore(),
      discoveryInterval: Duration.zero,
    )..reading = reading;
    clients.add(made);
    return made;
  }

  Iterable<String> stored() sync* {
    final local = web.window.localStorage;
    for (var i = 0; i < local.length; i++) {
      yield local.key(i)!;
    }
  }

  setUp(() {
    // Flutter's isolated test origin; never the user's browser profile.
    web.window.localStorage.clear();
  });
  tearDown(() {
    for (final made in clients) {
      made.dispose();
    }
    clients.clear();
    web.window.localStorage.clear();
  });

  test('signing out removes that account\'s Swarm keys from localStorage, '
      'and keeps another account\'s and the page\'s own', () async {
    final page = client()..bind('owner');
    await page.forgotten;
    for (final key in [
      'super_tab.owner.tab',
      'super_tab.launch.owner.desk.lead',
      'super_tab.hidden.owner',
      'super_tab.personal.owner',
    ]) {
      await page.storage.write(key, '{}');
    }
    web.window.localStorage
      ..setItem('${prefix}super_tab.other.tab', '{}')
      ..setItem('${prefix}theme_mode', 'dark');
    expect(stored().where((k) => k.contains('.owner')), hasLength(4));

    page.bind(null);
    await page.forgotten;
    expect(stored().where((k) => k.contains('.owner')), isEmpty);
    expect(
      web.window.localStorage.getItem('${prefix}super_tab.other.tab'),
      '{}',
    );
    expect(web.window.localStorage.getItem('${prefix}theme_mode'), 'dark');

    // A late save from this page after the sign-out is dropped.
    await page.storage.write('super_tab.owner.tab', '{"drafts":{}}');
    expect(
      web.window.localStorage.getItem('${prefix}super_tab.owner.tab'),
      isNull,
    );

    // Another page wrote one before it reloaded: the next page's start sweeps it.
    web.window.localStorage.setItem('${prefix}super_tab.owner.tab', '{}');
    final next = client()..bind(null);
    await next.forgotten;
    expect(
      web.window.localStorage.getItem('${prefix}super_tab.owner.tab'),
      isNull,
    );
  });
}
