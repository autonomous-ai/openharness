import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The flows the phone counts as the desktop does — its dials, a stopped harness resumed — as the
/// app itself reports them, through the account's own sharing.
void main() {
  late ProductMeasurement usage;

  setUp(() {
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      sendSetup: (_) async => {'accepted': true},
    );
  });

  /// A signed-in phone whose account shares product usage.
  Future<ViewerRig> sharing(Map<String, List<String>> agents) async {
    final rig = await signedInWith(agents, productMeasurement: usage);
    addTearDown(rig.app.dispose);
    await usage.flush();
    expect(usage.sharing, isTrue);
    return rig;
  }

  /// The [flow] counters the rig's account was sent, summed across reports.
  Future<Map<String, int>> sent(ViewerRig rig, String flow) async {
    await usage.flush();
    await usage.flush();
    final total = <String, int>{};
    for (final report in rig.api.usageReports) {
      (report['counters'] as Map).forEach((metric, value) {
        if ('$metric'.startsWith('ui_phone_${flow}_')) {
          total[metric as String] = (total[metric] ?? 0) + (value as int);
        }
      });
    }
    return total;
  }

  group('dials', () {
    test('a socket coming back by itself is the app\'s own', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);

      expect(
        await sent(rig, 'connect_auto'),
        allOf([
          containsPair('ui_phone_connect_auto_started', 1),
          containsPair('ui_phone_connect_auto_ok', 1),
        ]),
      );
      expect(await sent(rig, 'connect_user'), isEmpty);
      // Still counted as before, beside the split.
      expect(
        await sent(rig, 'remote_connect'),
        containsPair('ui_phone_remote_connect_ok', 1),
      );
    });

    test('Try again on a dropped computer is the person\'s', () async {
      final rig = await sharing({'m': []});
      rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);

      final retry = rig.app.retryMachine('m');
      await settle();
      rig.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await retry;

      expect(
        await sent(rig, 'connect_user'),
        allOf([
          containsPair('ui_phone_connect_user_started', 1),
          containsPair('ui_phone_connect_user_ok', 1),
        ]),
      );
      expect(await sent(rig, 'connect_auto'), isEmpty);
    });

    test('Try again on a computer already up is answered at once', () async {
      final rig = await sharing({'m': []});
      await rig.app.retryMachine('m');

      expect(
        await sent(rig, 'connect_user'),
        containsPair('ui_phone_connect_user_ok', 1),
      );
    });
  });

  group('resuming a stopped harness', () {
    Map<String, dynamic> stopped(String id) =>
        agentJson(id, status: 'stopped', terminal: false, sessionId: 's-$id');

    Future<ViewerRig> withStopped() async {
      final rig = await sharing({'m': []});
      await push(rig, 'm', 'agent_synced', {'agent': stopped('a')});
      return rig;
    }

    test(
      'is recovered by its first live turn, not by a replayed one',
      () async {
        final rig = await withStopped();
        rig.conn('m').answers['agent_resume'] = (p) => {
          'creationId': p['creationId'],
          'state': 'created',
          'agent': agentJson('a', sessionId: 's-a'),
        };

        expect((await rig.app.resumeAgent('m', 'a')).error, isNull);
        await push(
          rig,
          'm',
          'turn_started',
          {'agentId': 'a'},
          {'replay': true},
        );
        expect(await sent(rig, 'resume_recovery'), {
          'ui_phone_resume_recovery_started': 1,
        });

        await push(rig, 'm', 'turn_started', {'agentId': 'a'});
        expect(
          await sent(rig, 'resume_recovery'),
          containsPair('ui_phone_resume_recovery_ok', 1),
        );
      },
    );

    test(
      'a refusal is failed, and a status check is no second resume',
      () async {
        final rig = await withStopped();
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw refusal('AGENT_BUSY');
        await rig.app.resumeAgent('m', 'a');

        expect(
          await sent(rig, 'resume_recovery'),
          allOf([
            containsPair('ui_phone_resume_recovery_started', 1),
            containsPair('ui_phone_resume_recovery_failed', 1),
          ]),
        );

        // A lost reply is checked on the next tap, under the same receipt: not counted again.
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw refusal('INTERNAL');
        await rig.app.resumeAgent('m', 'a');
        rig.conn('m').answers['agent_create_status'] = (p) => {
          'creationId': p['creationId'],
          'state': 'pending',
        };
        await rig.app.resumeAgent('m', 'a');
        expect(
          (await sent(
            rig,
            'resume_recovery',
          ))['ui_phone_resume_recovery_started'],
          2,
        );
      },
    );
  });

  group('the signed-out choice, carried to the account as on the desktop', () {
    String? kept(MemoryKeyValueStore storage) =>
        storage.values[ProductMeasurement.setupPreferenceKey];

    test(
      'an opt-out made signed out turns the account off, asked once',
      () async {
        final storage = MemoryKeyValueStore()
          ..values[ProductMeasurement.setupPreferenceKey] =
              ProductMeasurement.pendingSetupOptOut;
        final rig = await signedInWith({'m': []}, storage: storage);
        addTearDown(rig.app.dispose);
        final usage = rig.app.productMeasurement;

        await usage.flush();
        await usage.setupChoiceSaved;
        expect(rig.api.usageChoiceAsks, [false]);
        expect(usage.accountOptOutPending, isFalse);
        expect(usage.sharing, isFalse);
        expect(kept(storage), 'false');

        await usage.flush();
        expect(rig.api.usageChoiceAsks, [
          false,
          null,
        ], reason: 'then only read');
      },
    );

    test(
      'left on, the account keeps its own choice, and the phone remembers it',
      () async {
        final storage = MemoryKeyValueStore();
        final rig = await signedInWith({'m': []}, storage: storage);
        addTearDown(rig.app.dispose);
        rig.api.usageChoice = {'enabled': false, 'revision': 2};
        final usage = rig.app.productMeasurement;

        await usage.flush();
        await usage.setupChoiceSaved;
        expect(rig.api.usageChoiceAsks, [null]);
        expect(usage.signedOutSharing, isFalse);
        expect(kept(storage), 'false');
      },
    );
  });
}
