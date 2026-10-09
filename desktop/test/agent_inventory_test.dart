import 'dart:async';
import 'dart:convert';

import 'support/agent_inventory_pages.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_inventory.dart';

final one = '1' * 64, two = '2' * 64, three = '3' * 64;
Map<String, dynamic> row(String id, [String? name]) => {
  'id': id,
  'name': name ?? id,
};
Map<String, dynamic> full(
  List<Map<String, dynamic>> agents, [
  String? revision,
]) => {
  'agents': agents,
  if (revision != null) 'sync': {'version': 1, 'revision': revision},
};
Map<String, dynamic> delta(
  String base,
  String revision,
  List<Map<String, dynamic>> agents, [
  List<String>? order,
]) => {
  'agents': agents,
  'sync': {'version': 1, 'base': base, 'revision': revision, 'order': ?order},
};
void main() {
  late AgentInventory inventory;
  late Object ui;
  setUp(() {
    inventory = AgentInventory();
    ui = Object();
  });
  Future<List<String>?> read(Map<String, dynamic> result) async {
    final next = await inventory.read((_) async => result, observe: () => ui);
    return next != null && next.commit()
        ? next.agents.map((a) => '${a.id}:${a.name}').toList()
        : null;
  }

  test('first full list, unchanged, complete replacements, additions, ordering and deletions', () async {
    expect(await read(full([row('a'), row('b')], one)), ['a:a', 'b:b']);
    expect(await read(delta(one, one, [])), ['a:a', 'b:b']);
    expect(
      await read(
        delta(one, two, [row('a', 'renamed'), row('c')], ['b', 'c', 'a']),
      ),
      ['b:b', 'c:c', 'a:renamed'],
    );
    expect(await read(delta(two, three, [], ['a'])), ['a:renamed']);
    expect(await read(delta(three, one, [], [])), isEmpty);
  });
  test(
    'legacy daemons return complete lists and never acquire a sync token',
    () async {
      await read(full([row('a')], one));
      await read(full([row('legacy')]));
      await inventory.read((request) async {
        expect(request, {'version': 1, 'pages': true});
        return full([]);
      }, observe: () => ui);
    },
  );
  test('a daemon cache miss can replace the whole accepted snapshot', () async {
    await read(full([row('a')], one));
    expect(await read(full([row('b')], two)), ['b:b']);
  });
  test(
    'malformed deltas retry once without a base and never commit partially',
    () async {
      final invalid = [
        delta(two, three, [], []), // wrong base
        delta(one, one, [row('a')]), // unchanged with a changed row
        delta(one, two, [row('new')], ['a']), // orphan changed row
        delta(one, two, [], ['unknown']),
        delta(one, two, [], ['a', 'a']),
        delta(one, two, [row('a'), row('a')], ['a']),
        delta(one, two, []), // no authoritative membership
        {
          'agents': [],
          'sync': {'version': 2},
        },
        {
          'agents': [],
          'sync': {'version': 1, 'revision': 'bad'},
        },
        {
          'agents': [null],
        },
        {
          'agents': [
            {'id': ''},
          ],
        },
        {
          'agents': [
            {'id': 'a', 'name': 42},
          ],
        },
        {
          'agents': [
            {'id': 'a', 'grid': 'malformed'},
          ],
        },
        {'error': 'broken'},
        {
          'agents': [],
          'sync': {'version': 1, 'revision': two, 'order': []},
        },
      ];
      for (final bad in invalid) {
        inventory.reset();
        await read(full([row('a')], one));
        var calls = 0;
        final result = await inventory.read((request) async {
          calls++;
          if (calls == 1) {
            expect(request['since'], one);
            return Map<String, dynamic>.from(bad);
          }
          expect(request, {'version': 1, 'pages': true});
          return full([row('recovered')], two);
        }, observe: () => ui);
        expect(calls, 2);
        expect(result!.commit(), isTrue);
        expect(result.agents.single.id, 'recovered');
      }
    },
  );
  test(
    'repeated invalid replies fail without clearing the last good baseline',
    () async {
      await read(full([row('a')], one));
      await expectLater(read({'error': 'invalid'}), throwsFormatException);
      expect(await read(delta(one, one, [])), ['a:a']);
    },
  );
  test(
    'a changed push during the request retries against the unadvanced baseline',
    () async {
      await read(full([row('a', 'old')], one));
      var calls = 0;
      final result = await inventory.read((request) async {
        expect(request['since'], one);
        if (++calls == 1) {
          ui = Object(); // agent_synced has changed the immutable UI roster
          return delta(one, one, []);
        }
        return delta(one, two, [row('a', 'new')], ['a']);
      }, observe: () => ui);
      expect(result!.commit(), isTrue);
      expect(result.agents.single.name, 'new');
      expect(calls, 2);
    },
  );
  test(
    'continuous pushes bound retries and keep the accepted revision',
    () async {
      await read(full([row('a')], one));
      var calls = 0;
      final result = await inventory.read((_) async {
        calls++;
        ui = Object();
        return delta(one, two, [], []);
      }, observe: () => ui);
      expect(result, isNull);
      expect(calls, 2);
      expect(await read(delta(one, one, [])), ['a:a']);
    },
  );
  test(
    'discovery reset discards in-flight replies and starts without a token',
    () async {
      await read(full([row('a')], one));
      final pending = Completer<Map<String, dynamic>>();
      final old = inventory.read((_) => pending.future, observe: () => ui);
      inventory.reset();
      pending.complete(delta(one, two, [], []));
      expect(await old, isNull);
      await inventory.read((request) async {
        expect(request, {'version': 1, 'pages': true});
        return full([row('new-machine')], three);
      }, observe: () => ui);
    },
  );
  test('the latest request owns the baseline when foreground and background overlap', () async {
    await read(full([row('a')], one));
    final pending = Completer<Map<String, dynamic>>();
    final old = inventory.read((_) => pending.future, observe: () => ui);
    await read(delta(one, two, [row('b')], ['b']));
    pending.complete(delta(one, three, [], []));
    expect(await old, isNull);
    expect(await read(delta(two, two, [])), ['b:b']);
  });
  test('a delta cannot bootstrap a new machine or account', () async {
    var calls = 0;
    await inventory.read((request) async {
      expect(request, {'version': 1, 'pages': true});
      return ++calls == 1 ? delta(one, one, []) : full([row('safe')], two);
    }, observe: () => ui);
    expect(calls, 2);
  });
  test('a push after decoding but before UI application cannot commit the snapshot', () async {
    await read(full([row('a')], one));
    final candidate = await inventory.read(
      (_) async => delta(one, two, [], []),
      observe: () => ui,
    );
    ui = Object();
    expect(candidate!.commit(), isFalse);
    expect(await read(delta(one, one, [])), ['a:a']);
  });
  test('a candidate commits only once', () async {
    final candidate = await inventory.read(
      (_) async => full([row('a')], one),
      observe: () => ui,
    );
    expect(candidate!.commit(), isTrue);
    expect(candidate.commit(), isFalse);
  });
  test('initial and delta sync assemble byte pages before publishing complete rows', () async {
    final name = '漢😀' * 45_000;
    final values = [
      full([row('a', name), row('b')], one),
      delta(one, two, [row('c', name)], ['b', 'c']),
    ];
    for (final value in values) {
      final pages = inventoryPages(value);
      expect(pages.length, greaterThan(2));
      var calls = 0;
      final result = await inventory.read((request) async {
        expect(request['pages'], isTrue);
        if (calls == 0) {
          expect(request['since'], value == values.first ? null : one);
        } else {
          expect(request, {
            'version': 1,
            'pages': true,
            'page': {'id': 'test-snapshot', 'offset': calls * 128 * 1024},
          });
        }
        return pages[calls++];
      }, observe: () => ui);
      expect(result!.agents.last.name, value == values.first ? 'b' : name);
      expect(result.commit(), isTrue);
      expect(calls, pages.length);
    }
    expect(await read(delta(two, two, [])), ['b:b', 'c:$name']);
  });

  test('an expired partial snapshot restarts once without advancing or erasing the baseline', () async {
    await read(full([row('old')], one));
    final pages = inventoryPages(full([row('a', 'x' * 150_000)], two));
    var calls = 0;
    final result = await inventory.read((request) async {
      switch (++calls) {
        case 1:
          expect(request['since'], one);
          return pages.first;
        case 2:
          expect(request['page'], isNotNull);
          return {'error': 'INVENTORY_RESET_REQUIRED'};
        default:
          expect(request, {'version': 1, 'pages': true});
          return full([row('recovered')], three);
      }
    }, observe: () => ui);
    expect(result!.commit(), isTrue);
    expect(result.agents.single.id, 'recovered');
    expect(calls, 3);
  });

  test('invalid pages and excessive logical snapshots preserve the last accepted inventory', () async {
    final valid = inventoryPages(full([row('new')], two)).single;
    final fields = valid['inventoryPage'] as Map<String, dynamic>;
    final bad = <Map<String, dynamic>>[
      {'inventoryPage': null},
      for (final patch in <Map<String, dynamic>>[
        {'version': 2},
        {'id': ''},
        {'id': 'x' * 65},
        {'id': 7},
        {'sha256': 'bad'},
        {'sha256': 7},
        {'sha256': one},
        {'totalBytes': 0},
        {'totalBytes': 1.5},
        {'totalBytes': 16 * 1024 * 1024 + 1},
        {'totalBytes': 1},
        {'totalBytes': (fields['totalBytes'] as int) + 1},
        {'offset': 1},
        {'data': 7},
        {'data': ''},
        {'data': '%%%broken'},
        {'data': 'a' * 174765},
        {'nextOffset': 1},
      ])
        {
          'inventoryPage': {...fields, ...patch},
        },
      {
        'inventoryPage': {...fields}..remove('nextOffset'),
      },
      inventoryBytePages(utf8.encode('[]')).single,
      inventoryBytePages(utf8.encode('invalid json')).single,
      inventoryBytePages([255, 254]).single,
    ];
    for (final response in bad) {
      inventory.reset();
      await read(full([row('old')], one));
      var calls = 0;
      await expectLater(
        inventory.read((_) async {
          calls++;
          return response;
        }, observe: () => ui),
        throwsFormatException,
      );
      expect(calls, 2);
      expect(await read(delta(one, one, [])), ['old:old']);
    }
    var calls = 0;
    await expectLater(
      inventory.read((_) async {
        calls++;
        return {'error': 'INVENTORY_TOO_LARGE', 'maxBytes': 16 * 1024 * 1024};
      }, observe: () => ui),
      throwsStateError,
    );
    expect(calls, 1);
    expect(await read(delta(one, one, [])), ['old:old']);
  });

  test('missing, duplicate, mixed, corrupt and out-of-order continuations never commit', () async {
    final pages = inventoryPages(full([row('new', 'x' * 150_000)], two));
    final second = pages.last['inventoryPage'] as Map<String, dynamic>;
    final bad = [
      full([row('truncated')], two),
      pages.first,
      for (final patch in <Map<String, dynamic>>[
        {'id': 'another-snapshot'},
        {'sha256': one},
        {'totalBytes': (second['totalBytes'] as int) + 1},
        {'offset': 2 * 128 * 1024},
        {
          'data': base64Encode([1, 2, 3]),
        },
        {
          'data': base64Encode(
            List.filled(base64Decode(second['data'] as String).length, 97),
          ),
        },
      ])
        {
          'inventoryPage': {...second, ...patch},
        },
    ];
    for (final response in bad) {
      inventory.reset();
      await read(full([row('old')], one));
      var calls = 0;
      await expectLater(
        inventory.read(
          (_) async => (++calls).isEven ? response : pages.first,
          observe: () => ui,
        ),
        throwsFormatException,
      );
      expect(calls, 4);
      expect(await read(delta(one, one, [])), ['old:old']);
    }
  });

  test(
    'push, reconnect and overlapping reads invalidate pages already fetched',
    () async {
      for (final action in ['push', 'reset', 'newer']) {
        inventory.reset();
        await read(full([row('old')], one));
        final pages = inventoryPages(full([row('stale', 'x' * 150_000)], two));
        final pending = Completer<Map<String, dynamic>>();
        final fetching = Completer<void>();
        var calls = 0;
        final result = inventory.read((request) async {
          switch (++calls) {
            case 1:
              return pages.first;
            case 2:
              fetching.complete();
              return pending.future;
            default:
              expect(request['since'], one);
              return full([row('fresh')], three);
          }
        }, observe: () => ui);
        await fetching.future;
        switch (action) {
          case 'push':
            ui = Object();
          case 'reset':
            inventory.reset();
          case 'newer':
            await read(full([row('newer')], three));
        }
        pending.complete(pages.last);
        final candidate = await result;
        if (action == 'push') {
          expect(candidate!.commit(), isTrue);
          expect(candidate.agents.single.id, 'fresh');
          expect(calls, 3);
        } else {
          expect(candidate, isNull);
          expect(calls, 2);
        }
      }
    },
  );
}
