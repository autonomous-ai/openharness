import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/uninstall_marker.dart';

void main() {
  late Directory home;
  late Map<String, String> environment;

  setUp(() {
    home = Directory.systemTemp.createTempSync('uninstall-marker-');
    Directory('${home.path}/.harness').createSync();
    environment = {'HOME': home.path, 'USERPROFILE': home.path};
  });
  tearDown(() => home.deleteSync(recursive: true));

  File marker() => File(UninstallMarker.path(environment: environment)!);
  String secondsAgo(Duration ago) =>
      '${DateTime.now().subtract(ago).millisecondsSinceEpoch ~/ 1000}\n';

  test('is the uninstalling file in the product root the CLI removes', () {
    expect(
      UninstallMarker.path(environment: environment),
      '${home.path}${Platform.pathSeparator}.harness${Platform.pathSeparator}uninstalling',
    );
  });

  test('holds while harness uninstall is at work, and not once it is gone', () {
    expect(UninstallMarker.held(environment: environment), isFalse);
    marker().writeAsStringSync(secondsAgo(Duration.zero));
    expect(UninstallMarker.held(environment: environment), isTrue);
    // The Windows last step is still removing files a few minutes in at most.
    marker().writeAsStringSync(secondsAgo(const Duration(minutes: 4)));
    expect(UninstallMarker.held(environment: environment), isTrue);
    marker().deleteSync();
    expect(UninstallMarker.held(environment: environment), isFalse);
  });

  test('a marker an uninstall killed half way left behind stops counting', () {
    // Believed for ever, it would leave this computer without a daemon the app keeps running.
    marker().writeAsStringSync(secondsAgo(const Duration(minutes: 11)));
    expect(UninstallMarker.held(environment: environment), isFalse);
    marker().writeAsStringSync('not a time\n');
    expect(UninstallMarker.held(environment: environment), isFalse);
    // A clock set back: a time to come is not believed either.
    marker().writeAsStringSync(secondsAgo(const Duration(hours: -1)));
    expect(UninstallMarker.held(environment: environment), isFalse);
  });
}
