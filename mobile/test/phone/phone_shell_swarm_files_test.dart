import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/settings/experimental_features.dart';

import 'devices_fixture.dart';

/// The shell keeps Swarm's picture files to the signed-in account: at start
/// it empties what another account left, and signing out empties the rest.
void main() {
  late DevicesApp app;
  late Directory temporary;
  late Directory files;
  const pathProvider = MethodChannel('plugins.flutter.io/path_provider');

  setUp(() {
    temporary = Directory.systemTemp.createTempSync('phone-temporary-');
    files = Directory('${temporary.path}/swarm-attachments');
    // The app's private temporary folder, as the platform names it.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          pathProvider,
          (call) async =>
              call.method == 'getTemporaryDirectory' ? temporary.path : null,
        );
    app = DevicesApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
    // In memory only: the value, not the store's write, so nothing reaches the state file.
    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProvider, null);
    experimentalFeaturesStore.value = const {};
    app.dispose();
    if (temporary.existsSync()) temporary.deleteSync(recursive: true);
  });

  /// Real time for the files to go, a frame after each step.
  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(done(), isTrue);
  }

  File leftIn(String folder) =>
      File('${files.path}/$folder/left.png')
        ..createSync(recursive: true)
        ..writeAsBytesSync([1, 2, 3]);

  testWidgets("at start, what another account left is emptied; signing out "
      'empties the rest', (tester) async {
    final other = leftIn('someone-else');

    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await until(tester, () => !other.existsSync());

    final mine = leftIn('anything-kept-now');
    app.currentUser = null;
    app.notifyListeners();
    await until(tester, () => !mine.existsSync());

    // The shell gone, and what its sign-out left running let run out.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  });
}
