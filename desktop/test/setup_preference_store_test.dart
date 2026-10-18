import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/setup_preference_store.dart';

void main() {
  late Directory directory;
  setUp(
    () async =>
        directory = await Directory.systemTemp.createTemp('setup-privacy-'),
  );
  tearDown(() async => directory.delete(recursive: true));

  Future<ProductMeasurement> open() async {
    final usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      setupStorage: SetupPreferenceStore(directory: directory),
      sendSetup: (_) async => {},
    );
    await usage.setupChoiceReady;
    addTearDown(usage.dispose);
    return usage;
  }

  test(
    'a new installation defaults on and stores only privacy flags',
    () async {
      final first = await open();
      expect(first.signedOutSharing, isTrue);
      expect(await directory.list().toList(), isEmpty);
      await first.setSignedOutSharing(false);
      expect(
        await SetupPreferenceStore(directory: directory).file.readAsString(),
        ProductMeasurement.pendingSetupOptOut,
      );
      expect((await open()).signedOutSharing, isFalse);
      expect(await directory.list().length, 1);
    },
  );

  test('corrupt or unreadable state never becomes a fresh default', () async {
    final file = SetupPreferenceStore(directory: directory).file;
    await file.writeAsString('{broken');
    expect((await open()).signedOutSharing, isFalse);
    await file.delete();
    await Directory(file.path).create();
    expect((await open()).signedOutSharing, isFalse);
  });
}
