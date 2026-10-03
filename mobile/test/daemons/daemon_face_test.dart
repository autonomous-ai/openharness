// The phone's face: boop > need > work > fail > idle, blinks that answer
// something (and never while working or booped), work frames that step on
// real agent events only, and nothing left running once it is at rest. tim,
// the octopus of drop init, keeps a one-line sprite; its portrait is a plate.
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';

Map<String, dynamic> _doc({
  int revision = 1,
  String version = '2.0',
  int xp = 600,
  List<Map<String, dynamic>> eggs = const [],
  List<String> daemons = const ['tim'],
}) => {
  'revision': revision,
  'zoo': {
    'daemons': [
      for (final id in daemons)
        {
          'id': id,
          'hatchedAt': '2026-09-26T09:42:00Z',
          'egg': 'first',
          'xp': xp,
        },
    ],
    'eggs': eggs,
    'pair': daemons.firstOrNull,
    'habits': const ['turn', 'split', 'find', 'machine', 'store'],
    'firstEgg': true,
  },
};

void main() {
  late Map<String, dynamic> doc;
  late ZooClient zoo;
  late DaemonFace face;
  late DateTime now;

  void start(FakeAsync async, {Map<String, dynamic>? with_}) {
    doc = with_ ?? _doc();
    now = DateTime(2026, 9, 26, 10);
    zoo = ZooClient(read: () async => doc, write: (_) async => doc);
    face = DaemonFace(zoo, now: () => now);
    zoo.ensure();
    async.flushMicrotasks();
    face.sync(const DaemonWatch());
  }

  void elapse(FakeAsync async, Duration d) {
    now = now.add(d);
    async.elapse(d);
  }

  tearDown(() {
    face.dispose();
    zoo.dispose();
  });

  const need = DaemonWatch(needs: {'m/a#q1'});
  const working = DaemonWatch(working: {'m/a'});
  const failing = DaemonWatch(failing: {'m/a'});

  test('the face follows boop, need, work, fail, idle in that order', () {
    fakeAsync((async) {
      start(async);
      expect(face.mood, DaemonMood.idle);
      face.sync(failing);
      expect(face.mood, DaemonMood.fail);
      face.sync(const DaemonWatch(working: {'m/b'}, failing: {'m/a'}));
      expect(face.mood, DaemonMood.work);
      face.sync(
        const DaemonWatch(needs: {'m/c#q'}, working: {'m/b'}, failing: {'m/a'}),
      );
      expect(face.mood, DaemonMood.need);
      face.boop();
      expect(face.mood, DaemonMood.boop);
      expect(face.glyph, '~(O O)~');
      // Its portrait is its plate at the mood: the boop's first frame.
      expect(
        face.portrait,
        daemonPlates
            .frames('tim', PlateSize.portrait, '2.0', DaemonMood.boop)
            .first,
      );
      // The boop is held 900 ms, then the face is what the work says.
      elapse(async, const Duration(milliseconds: 899));
      expect(face.mood, DaemonMood.boop);
      elapse(async, const Duration(milliseconds: 1));
      expect(face.mood, DaemonMood.need);
      face.sync(const DaemonWatch());
      expect(face.mood, DaemonMood.idle);
      // The turns that ended get their ack; then everything is at rest.
      elapse(async, const Duration(milliseconds: 400));
      expect(face.animating, isFalse);
    });
  });

  test('a harness needing you gets one ack blink; a baseline gets none', () {
    fakeAsync((async) {
      start(async);
      face.sync(need);
      elapse(async, const Duration(milliseconds: 159));
      expect(face.lid, isNull);
      elapse(async, const Duration(milliseconds: 1));
      expect(face.lid, '-');
      elapse(async, const Duration(milliseconds: 120));
      expect(face.lid, isNull);
      expect(face.animating, isFalse);

      // The same question again (a reconnect re-announcing it) is not news.
      face.sync(need);
      elapse(async, const Duration(seconds: 1));
      expect(face.lid, isNull);
    });
  });

  test('the first sync after the zoo loads is a baseline', () {
    fakeAsync((async) {
      doc = _doc();
      now = DateTime(2026, 9, 26);
      zoo = ZooClient(read: () async => doc, write: (_) async => doc);
      face = DaemonFace(zoo, now: () => now);
      zoo.ensure();
      async.flushMicrotasks();
      // Restored state: a harness was already waiting when the app opened.
      face.sync(need);
      elapse(async, const Duration(seconds: 1));
      expect(face.mood, DaemonMood.need);
      expect(face.lid, isNull);
    });
  });

  test('no blinks while working or booped', () {
    fakeAsync((async) {
      start(async);
      face.sync(working);
      // A new question while working: need wins, and need may blink.
      face.sync(const DaemonWatch(working: {'m/a'}, failing: {'m/b'}));
      elapse(async, const Duration(milliseconds: 160));
      // Working: the ack for the failure is drawn without a lid.
      expect(face.mood, DaemonMood.work);
      expect(face.lid, isNull);
      face.boop();
      face.look();
      elapse(async, const Duration(milliseconds: 300));
      expect(face.lid, isNull);
    });
  });

  test('look blinks at most once every 2.5 s', () {
    fakeAsync((async) {
      start(async);
      var blinks = 0;
      String? last;
      face.addListener(() {
        if (face.lid != null && last == null) blinks++;
        last = face.lid;
      });
      face.look();
      elapse(async, const Duration(milliseconds: 500));
      face.look();
      elapse(async, const Duration(milliseconds: 500));
      expect(blinks, 1);
      elapse(async, const Duration(seconds: 2));
      face.look();
      elapse(async, const Duration(milliseconds: 500));
      expect(blinks, 2);
    });
  });

  test('work frames step on agent events, at most twice a second', () {
    fakeAsync((async) {
      start(async);
      face.sync(working);
      expect(face.step, 0);
      final first = face.glyph;
      // Nothing happens with no events: no animation timer.
      elapse(async, const Duration(seconds: 3));
      expect(face.step, 0);
      expect(face.animating, isFalse);

      face.pulse();
      expect(face.step, 1);
      expect(face.glyph, isNot(first));
      // A burst inside the half second: one trailing step, not five.
      for (var i = 0; i < 5; i++) {
        elapse(async, const Duration(milliseconds: 50));
        face.pulse();
      }
      expect(face.step, 1);
      elapse(async, const Duration(milliseconds: 250));
      expect(face.step, 2);
      elapse(async, const Duration(seconds: 2));
      expect(face.step, 2);

      // The work ends: the face is at rest, and nothing is left running.
      face.sync(const DaemonWatch());
      expect(face.step, 0);
      expect(face.glyph, '~(o o)~');
      face.pulse();
      expect(face.step, 0);
      elapse(async, const Duration(milliseconds: 400));
      expect(face.animating, isFalse);
    });
  });

  test('Reduce Motion stops frames and blinks; the face still changes', () {
    fakeAsync((async) {
      start(async);
      face.setEnvironment(foreground: true, reduceMotion: true);
      face.sync(working);
      face.pulse();
      expect(face.step, 0);
      expect(face.mood, DaemonMood.work);
      expect(face.glyph, '~(= =)~');
      face.sync(need);
      elapse(async, const Duration(seconds: 1));
      expect(face.mood, DaemonMood.need);
      expect(face.lid, isNull);
      face.look();
      elapse(async, const Duration(seconds: 1));
      expect(face.lid, isNull);
      expect(face.animating, isFalse);
    });
  });

  test('a younger daemon borrows the baton, and its face never shifts', () {
    fakeAsync((async) {
      start(async, with_: _doc(version: '0.1', xp: 0));
      face.sync(working);
      face.pulse();
      expect(face.glyph, endsWith('/'));
      // The cell centres on the base sprite: the baton grows to the right.
      final idle = face.cell.indexOf('(');
      expect(idle, greaterThan(0));
      face.sync(const DaemonWatch());
      expect(face.cell.indexOf('('), idle);
    });
  });

  test('before any daemon the chip is the nest, then the ready egg', () {
    fakeAsync((async) {
      start(
        async,
        with_: {
          'revision': 1,
          'zoo': {
            'daemons': const [],
            'eggs': const [],
            'habits': const ['turn', 'split'],
          },
        },
      );
      expect(face.def, isNull);
      // A turn and one more: two of the three the first egg needs.
      expect(face.glyph, r"\_(*')_/");
      expect(face.semantics, contains('2 of 3 habits'));
      doc = {
        'revision': 2,
        'zoo': {
          'daemons': const [],
          'eggs': [
            {'id': 'e1', 'kind': 'first', 'grantedAt': ''},
          ],
          'habits': const ['turn', 'split', 'find', 'machine', 'store'],
          'firstEgg': true,
        },
      };
      zoo.noticeRevision(2);
      async.flushMicrotasks();
      expect(face.eggReady, isTrue);
      expect(face.glyph, r'\_(oo)_/');
      // A boop on an egg is nothing.
      face.boop();
      expect(face.animating, isFalse);
    });
  });

  test('meeting it after the reveal is a slow blink', () {
    fakeAsync((async) {
      start(async);
      face.beginReveal();
      expect(face.def, isNull);
      expect(face.semantics, 'Hatching');
      face.endReveal();
      expect(face.def!.id, 'tim');
      final lids = <String?>[];
      face.addListener(() => lids.add(face.lid));
      elapse(async, const Duration(seconds: 2));
      expect(lids.whereType<String>().toList(), ['_', '-', '_']);
      expect(face.animating, isFalse);
    });
  });

  test('growing up is a slow blink', () {
    fakeAsync((async) {
      start(async, with_: _doc(version: '1.0', xp: 150));
      final lids = <String?>[];
      face.addListener(() => lids.add(face.lid));
      doc = _doc(revision: 2, xp: 600);
      zoo.noticeRevision(2);
      async.flushMicrotasks();
      elapse(async, const Duration(seconds: 2));
      expect(face.daemon!.version, '2.0');
      expect(lids.whereType<String>().toList(), ['_', '-', '_']);
    });
  });

  test('a line-art daemon of a held drop still draws its line portrait', () {
    fakeAsync((async) {
      start(async, with_: _doc(daemons: const ['tmux']));
      expect(face.def!.plate, isFalse);
      expect(face.glyph, r'\[o|o]/');
      expect(
        face.portrait,
        renderPortrait(
          face.roster,
          face.def!,
          '2.0',
          DaemonMood.idle,
          motion: false,
        ),
      );
      face.sync(working);
      expect(face.glyph, r'\[=|=]/');
    });
  });
}
