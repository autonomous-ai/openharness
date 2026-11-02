import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_kept.dart';

class _Key implements SwarmHomeKey {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String next) async => value = next;
  @override
  Future<void> delete() async => value = null;
}

/// What a person wrote, kept on the phone: sealed, one account's, and gone with
/// it (Tony's mobile list, task 25).
void main() {
  late Directory dir;
  late _Key key;
  late SealedSwarmKeptStore store;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('swarm-kept');
    key = _Key();
    store = SealedSwarmKeptStore(key: key, file: File('${dir.path}/kept.bin'));
  });
  tearDown(() => dir.deleteSync(recursive: true));

  const secret = 'the words only I wrote';
  final state = {
    'drafts': [
      {'tab': 't', 'chat': 'c', 'text': secret},
    ],
    'posts': <Object>[],
  };

  test('reads back what it kept, for that account', () async {
    await store.write('me', state);
    expect(await store.read('me'), state);
  });

  test('is sealed: the words are not in the file', () async {
    await store.write('me', state);
    final raw = String.fromCharCodes(store.file.readAsBytesSync());
    expect(raw, isNot(contains(secret)));
  });

  test("another account reads none, and it goes", () async {
    await store.write('me', state);
    expect(await store.read('you'), isNull);
    expect(store.file.existsSync(), isFalse);
  });

  test('a clear takes the file and the key', () async {
    await store.write('me', state);
    await store.clear();
    expect(store.file.existsSync(), isFalse);
    expect(key.value, isNull);
    expect(await store.read('me'), isNull);
  });

  test('a clear is not undone by a write just before it', () async {
    final write = store.write('me', state);
    final clear = store.clear();
    await Future.wait([write, clear]);
    expect(store.file.existsSync(), isFalse);
    expect(await store.read('me'), isNull);
  });

  test('a damaged file, or a lost key, is none', () async {
    await store.write('me', state);
    store.file.writeAsBytesSync([1, 2, 3]);
    expect(await store.read('me'), isNull);
    await store.write('me', state);
    key.value = null;
    expect(await store.read('me'), isNull);
  });

  group('SwarmKept', () {
    late MemorySwarmKeptStore memory;

    Future<SwarmKept> open() async {
      final kept = SwarmKept(
        accountId: 'me',
        store: memory,
        saveAfter: Duration.zero,
      );
      addTearDown(kept.dispose);
      await kept.ready;
      return kept;
    }

    setUp(() => memory = MemorySwarmKeptStore());

    test('a draft comes back in the next session, by chat and thread', () async {
      final first = await open();
      first.setDraft('t', 'c', null, 'chat words', {'a1': '@Ann'});
      first.setDraft('t', 'c', 'r', 'thread words');
      first.setDraft('t', 'other', null, 'other words');
      await first.flush();
      final next = await open();
      expect(next.draft('t', 'c', null)?.text, 'chat words');
      expect(next.draft('t', 'c', null)?.mentions, {'a1': '@Ann'});
      expect(next.draft('t', 'c', 'r')?.text, 'thread words');
      expect(next.draft('u', 'c', null), isNull);
    });

    test('an emptied draft leaves', () async {
      final first = await open();
      first.setDraft('t', 'c', null, 'words');
      first.setDraft('t', 'c', null, '');
      await first.flush();
      expect((await open()).draft('t', 'c', null), isNull);
    });

    test('posts come back as kept, and leave when set empty', () async {
      final first = await open();
      final post = {
        'body': {'operationId': 'op'},
        'messageId': 'm',
      };
      first.setPosts('t', 'c', null, [post]);
      await first.flush();
      expect((await open()).posts('t', 'c', null), [post]);
      first.setPosts('t', 'c', null, const []);
      await first.flush();
      expect((await open()).posts('t', 'c', null), isEmpty);
    });

    test('a chat or a Swarm dropped takes its own only', () async {
      final kept = await open();
      kept
        ..setDraft('t', 'c', null, 'a')
        ..setDraft('t', 'c', 'r', 'b')
        ..setDraft('t', 'd', null, 'c')
        ..setDraft('u', 'c', null, 'd')
        ..setPosts('t', 'c', null, [
          {'messageId': 'm'},
        ]);
      kept.dropChat('t', 'c');
      expect(kept.draft('t', 'c', null), isNull);
      expect(kept.draft('t', 'c', 'r'), isNull);
      expect(kept.posts('t', 'c', null), isEmpty);
      expect(kept.draft('t', 'd', null)?.text, 'c');
      kept.dropSwarm('t');
      expect(kept.draft('t', 'd', null), isNull);
      expect(kept.draft('u', 'c', null)?.text, 'd');
      await kept.flush();
      final next = await open();
      expect(next.draft('t', 'd', null), isNull);
      expect(next.draft('u', 'c', null)?.text, 'd');
    });

    test('names the chats it holds in a Swarm', () async {
      final kept = await open();
      kept
        ..setDraft('t', 'c', 'r', 'a')
        ..setPosts('t', 'd', null, [
          {'messageId': 'm'},
        ])
        ..setDraft('u', 'e', null, 'b');
      expect(kept.chats('t'), {'c', 'd'});
    });

    test('keeps the newest drafts and posts past its caps', () async {
      final kept = await open();
      for (var i = 0; i <= SwarmKept.maxDrafts; i++) {
        kept.setDraft('t', 'c$i', null, 'words');
      }
      for (var i = 0; i <= SwarmKept.maxPosts; i++) {
        kept.setPosts('t', 'p$i', null, [
          {'messageId': 'm$i'},
        ]);
      }
      expect(kept.draft('t', 'c0', null), isNull);
      expect(kept.draft('t', 'c${SwarmKept.maxDrafts}', null), isNotNull);
      expect(kept.posts('t', 'p0', null), isEmpty);
      expect(kept.posts('t', 'p${SwarmKept.maxPosts}', null), isNotEmpty);
    });

    test('what was written before it read back is not lost', () async {
      memory.held = {
        'drafts': [
          {'tab': 't', 'chat': 'old', 'text': 'kept'},
          {'tab': 't', 'chat': 'c', 'text': 'older'},
        ],
        'posts': <Object>[],
      };
      final kept = SwarmKept(
        accountId: 'me',
        store: memory,
        saveAfter: Duration.zero,
      );
      addTearDown(kept.dispose);
      kept.setDraft('t', 'c', null, 'newer');
      await kept.ready;
      expect(kept.draft('t', 'c', null)?.text, 'newer');
      expect(kept.draft('t', 'old', null)?.text, 'kept');
    });

    test('with no store, it holds for the session', () async {
      final kept = SwarmKept(accountId: 'me');
      addTearDown(kept.dispose);
      kept.setDraft('t', 'c', null, 'words');
      expect(kept.loaded, isTrue);
      expect(kept.draft('t', 'c', null)?.text, 'words');
    });
  });
}
