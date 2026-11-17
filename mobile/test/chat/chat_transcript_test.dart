import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/chat/chat_transcript.dart';
import 'package:harness_mobile/chat/chat_view_store.dart';

import '../voice_fakes.dart';

Map<String, dynamic> _event(String type, Map<String, dynamic> payload) => {
  'type': type,
  'payload': payload,
};

ChatHistoryPage _page(
  List<Map<String, dynamic>> events, {
  bool hasMore = false,
  String? cursor,
}) => (events: events, hasMore: hasMore, oldestCursor: cursor);

void main() {
  group('a conversation as chat', () {
    test(
      'reads its newest page into rows: asked, answered, and the tools run',
      () async {
        final conversation = ChatConversation(
          read: (_) async => _page([
            _event('user_message', {'content': 'fix the build'}),
            _event('text_delta', {'content': 'Looking.'}),
            _event('tool_start', {
              'id': 't1',
              'tool': 'Bash',
              'input': {'command': 'npm run build'},
            }),
            _event('tool_end', {'id': 't1', 'tool': 'Bash', 'isError': true}),
            _event('text_delta', {'content': 'Fixed.'}),
          ]),
        );
        await conversation.open();

        expect(conversation.load, ChatLoad.loaded);
        expect(conversation.items.map((i) => i.role), [
          ChatRole.user,
          ChatRole.assistant,
          ChatRole.tool,
          ChatRole.assistant,
        ]);
        final tool = conversation.items[2];
        expect(tool.tool, 'Bash');
        expect(tool.text, 'npm run build');
        expect(tool.toolDone, isTrue);
        expect(tool.toolError, isTrue);
      },
    );

    test(
      'live events follow the page, and a request said twice is drawn once',
      () async {
        final conversation = ChatConversation(read: (_) async => _page([]));
        await conversation.open();

        conversation
          ..ingest('turn_started', {'userMessage': 'add tests'})
          ..ingest('user_message', {'content': 'add tests'});
        expect(conversation.working, isTrue);
        conversation
          ..ingest('text_delta', {'content': 'Done.'})
          ..ingest('turn_ended', {});

        expect(conversation.items.map((i) => (i.role, i.text)), [
          (ChatRole.user, 'add tests'),
          (ChatRole.assistant, 'Done.'),
        ]);
        expect(conversation.working, isFalse);
        expect(conversation.lastTurn, isNotNull);
      },
    );

    test(
      'a live event that landed during the read is not drawn twice',
      () async {
        final read = Completer<ChatHistoryPage>();
        final conversation = ChatConversation(read: (_) => read.future);
        final opening = conversation.open();

        conversation
          ..ingest('text_delta', {'content': 'Already in the page.'})
          ..ingest('text_delta', {'content': 'Only live.'});
        read.complete(
          _page([
            _event('text_delta', {'content': 'Already in the page.'}),
          ]),
        );
        await opening;

        expect(conversation.items.map((i) => i.text), [
          'Already in the page.',
          'Only live.',
        ]);
      },
    );

    test('an engine that streams its answer grows one row', () async {
      final conversation = ChatConversation(
        read: (_) async => _page([]),
        streamsText: true,
      );
      await conversation.open();
      conversation
        ..ingest('text_delta', {'content': 'Hel'})
        ..ingest('text_delta', {'content': 'lo'});

      expect(conversation.items.single.text, 'Hello');
    });

    test('the page before the oldest is put above it', () async {
      final conversation = ChatConversation(
        read: (before) async => before == null
            ? _page(
                [
                  _event('user_message', {'content': 'second'}),
                ],
                hasMore: true,
                cursor: 'c1',
              )
            : _page([
                _event('user_message', {'content': 'first'}),
              ]),
      );
      await conversation.open();
      await conversation.loadOlder();

      expect(conversation.items.map((i) => i.text), ['first', 'second']);
      expect(conversation.hasMore, isFalse);
    });

    test('a failed read says so and can be asked again', () async {
      var fail = true;
      final conversation = ChatConversation(
        read: (_) async {
          if (fail) throw StateError('ENGINE_BUSY');
          return _page([
            _event('user_message', {'content': 'hi'}),
          ]);
        },
      );
      await conversation.open();
      expect(conversation.load, ChatLoad.failed);

      fail = false;
      await conversation.open();
      expect(conversation.load, ChatLoad.loaded);
      expect(conversation.items.single.text, 'hi');
    });
  });

  test('a tool is summed up by what it was given', () {
    expect(
      toolInputSummary({'file_path': '/a/b.dart', 'old': 'x'}),
      '/a/b.dart',
    );
    expect(toolInputSummary({'command': 'ls\nrm -rf x'}), 'ls');
    expect(toolInputSummary('git status'), 'git status');
    expect(toolInputSummary(null), '');
  });

  group('the conversations held', () {
    test('read once each, and only an open one hears live events', () async {
      var reads = 0;
      final conversations = ChatConversations(
        reader: (machineId, sessionId) => (_) async {
          reads++;
          return _page([]);
        },
      );
      final first = conversations.open('m1', 'a1', 's1');
      expect(identical(conversations.open('m1', 'a1', 's1'), first), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(reads, 1);

      conversations
        ..ingest('m1', 'a1', 's1', 'text_delta', {'content': 'mine'})
        ..ingest('m1', 'a2', 's2', 'text_delta', {'content': 'not mine'});
      expect(first.items.map((i) => i.text), ['mine']);
    });

    test('an agent nobody has talked to yet is an empty chat, read from nowhere, and its first session a chat of its own', () async {
      final read = <String>[];
      final conversations = ChatConversations(
        reader: (machineId, sessionId) => (_) async {
          read.add(sessionId);
          return _page([]);
        },
      );
      // OpenCode makes its session at the first message (MSI, 2026-11-17: Show chat did nothing on such an agent).
      final empty = conversations.open('m1', 'a1', null);
      await Future<void>.delayed(Duration.zero);
      expect(empty.load, ChatLoad.loaded);
      expect(empty.items, isEmpty);
      expect(read, isEmpty);

      final first = conversations.open('m1', 'a1', 's1');
      await Future<void>.delayed(Duration.zero);
      expect(identical(first, empty), isFalse);
      expect(read, ['s1']);
    });
  });

  group('how agents open', () {
    test(
      'terminal until Chat UI is on; one agent can be switched either way',
      () async {
        final storage = MemoryKeyValueStore();
        final store = ChatViewStore(storage: storage);
        await store.load();
        expect(store.showsChat('m', 'a'), isFalse);

        await store.setShowsChat('m', 'a', true);
        expect(store.showsChat('m', 'a'), isTrue);
        expect(store.showsChat('m', 'b'), isFalse);

        // The Settings switch says how every agent opens.
        await store.setChatByDefault(true);
        expect(store.showsChat('m', 'b'), isTrue);
        await store.setShowsChat('m', 'b', false);
        expect(store.showsChat('m', 'b'), isFalse);

        final again = ChatViewStore(storage: storage);
        await again.load();
        expect(again.chatByDefault, isTrue);
        expect(again.showsChat('m', 'a'), isTrue);
        expect(again.showsChat('m', 'b'), isFalse);
      },
    );
  });
}
