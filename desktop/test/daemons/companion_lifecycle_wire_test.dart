import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/companion_life.dart';
import 'package:harness/daemons/companion_publisher.dart';
import 'package:harness/daemons/daemon_face.dart';
import 'package:harness/daemons/daemon_settings.dart';
import 'package:harness/daemons/zoo_controller.dart';

class _MemoryOnly implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => null;
  @override
  Future<void> write(String key, String value) async =>
      fail('Preview wrote storage');
  @override
  Future<void> delete(String key) async => fail('Preview deleted storage');
}

class _TimDraw implements Random {
  final _ids = Random(42);
  @override
  bool nextBool() => _ids.nextBool();
  @override
  int nextInt(int max) => _ids.nextInt(max);
  @override
  double nextDouble() => .01; // First weighted species: Tim. IDs still unique.
}

void main() {
  testWidgets(
    'one saved life: egg, hatch, same Tim at every age, emotions, off',
    (tester) async {
      var clock = DateTime.utc(2026, 9, 28, 9);
      final zoo = ZooController(
        storage: _MemoryOnly(),
        random: _TimDraw(),
        now: () => clock,
      );
      final settings = DaemonSettings(
        storage: _MemoryOnly(),
        canPersist: () => false,
      );
      final face = DaemonFace(zoo, settings: settings, now: () => clock);
      var disposed = false;
      void cleanup() {
        if (disposed) return;
        disposed = true;
        face.dispose();
        settings.dispose();
        zoo.dispose();
      }

      addTearDown(cleanup);
      final wire = <Map<String, dynamic>>[];
      final publisher = CompanionPublisher(
        window: 'desktop-fixture',
        now: () => clock,
        send: (p) {
          wire.add(p);
          return true;
        },
      );
      void publish() => publisher.publish(
        face.companionPresentation,
        scope: 'fixture',
        foreground: true,
        force: true,
      );
      zoo.showPreview();
      face.setLiving(true);
      face.sync(const DaemonWatch());
      publish();
      expect(wire.last['egg'], containsPair('stage', 'p0'));
      for (final habit in ['split', 'find', 'turn']) {
        zoo.habit(habit);
        publish();
      }
      expect(wire.last['egg'], containsPair('stage', 'p4'));
      expect(zoo.paired, isNull, reason: 'Ready never hatches by itself');
      face.beginReveal(kind: zoo.readyEgg!.kind);
      final hatch = await zoo.hatch(zoo.readyEgg!.id);
      expect(hatch!.daemonId, 'tim');
      for (final stage in ['rock', 'burst', 'tumble', 'open', 'hatchling']) {
        face.revealAt(stage);
        publish();
      }
      face.endReveal();
      publish();
      final uid = zoo.paired!.uid, seed = zoo.paired!.seed;
      expect(wire.last['creature'], containsPair('version', '0.1'));
      // Real earning caps apply: simulate several workdays, never bypass them.
      for (final age in ['1.0', '2.0']) {
        for (var day = 0; day < 90 && zoo.paired!.version != age; day++) {
          zoo.recordTurns(50, machineId: 'fixture');
          clock = clock.add(const Duration(days: 1));
          await tester.pump();
        }
        publish();
        expect(wire.last['creature'], containsPair('version', age));
      }
      expect(zoo.paired!.uid, uid);
      expect(zoo.paired!.seed, seed);
      clock = clock.add(const Duration(seconds: 12));
      face.react(CompanionEvent.merged, 'merge:fixture/442');
      publish();
      expect(wire.last['feeling'], containsPair('emotion', 'excited'));
      settings.motion = false;
      publish();
      expect(wire.last['motion'], false);
      face.setLiving(false);
      publish();
      expect(wire.last['enabled'], false);
      expect(
        zoo.paired!.uid,
        uid,
        reason: 'The switch never erases the saved life',
      );
      // Explicit opt-in export for the real TypeScript -> C replay runner.
      final path = Platform.environment['COMPANION_DESKTOP_WIRE'];
      if (path != null) File(path).writeAsStringSync(jsonEncode(wire));
      cleanup();
    },
  );
}
