import 'dart:async';

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
        expect(request, {'version': 1});
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
          expect(request, {'version': 1});
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
        expect(request, {'version': 1});
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
      expect(request, {'version': 1});
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
}
