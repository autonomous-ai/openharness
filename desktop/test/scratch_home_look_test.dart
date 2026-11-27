import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_home.dart';

import 'support/scratch_home_look.dart';

void main() {
  late Directory root;
  late Directory elsewhere;
  setUp(() {
    root = Directory.systemTemp.createTempSync('scratch-look-');
    elsewhere = Directory.systemTemp.createTempSync('scratch-look-other-');
  });
  tearDown(() {
    root.deleteSync(recursive: true);
    elsewhere.deleteSync(recursive: true);
  });

  test(
    'an XDG folder the rule refuses fails the test, never sends it to the home',
    () {
      expect(
        () => scratchHomeLook(
          root.path,
          environment: {'XDG_STATE_HOME': 'state'},
        ),
        throwsArgumentError,
      );
    },
  );

  test(
    'a path outside its folder fails the test instead of being looked at',
    () {
      final look = scratchHomeLook(root.path);
      final outside = '${elsewhere.path}/.harness';
      Directory(outside).createSync();
      expect(() => look.exists(outside), throwsStateError);
      expect(() => look.isFile(outside), throwsStateError);
    },
  );

  test('the rule run on a home outside its folder fails closed', () {
    expect(
      () => HarnessHome.of(elsewhere.path, look: scratchHomeLook(root.path)),
      throwsStateError,
    );
  });

  test('inside its folder it answers from the disk', () {
    final look = scratchHomeLook(root.path);
    File('${root.path}/.local/share/harness/.harness-root')
        .createSync(recursive: true);
    expect(look.linux, isTrue);
    expect(
      look.isFile('${root.path}/.local/share/harness/.harness-root'),
      isTrue,
    );
    expect(look.isFile('${root.path}/.local/share/harness'), isFalse);
    expect(look.exists('${root.path}/.local/share/harness'), isTrue);
    expect(look.exists('${root.path}/.harness'), isFalse);
    expect(
      HarnessHome.of(
        root.path,
        join: separatorJoin('/'),
        look: look,
      ).root(HarnessRootKind.data),
      '${root.path}/.local/share/harness',
    );
  });
}
