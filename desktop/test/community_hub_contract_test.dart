import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/hub_contract.dart';

/// `hub_contract.dart` mirrors what the backend accepts. A rule changed there and not here makes
/// Publish to Hub hand the browser drafts the Hub refuses, so this reads the backend's own source.
void main() {
  late String contract;
  setUpAll(() {
    final file = File('../backend/src/lib/communityContract.ts');
    if (!file.existsSync()) {
      throw StateError(
        '${file.path} missing — run from desktop/ in the monorepo',
      );
    }
    contract = file.readAsStringSync();
  });

  String block(String name) {
    final from = contract.indexOf('export const $name');
    if (from < 0) throw StateError('"$name" is gone from communityContract.ts');
    return contract.substring(from, contract.indexOf(RegExp(r'\n\}|\]'), from));
  }

  int limit(String key) {
    final match = RegExp('\\b$key: ([0-9_]+)')
        .firstMatch(block('communityLimits'));
    if (match == null) throw StateError('communityLimits.$key is gone');
    return int.parse(match[1]!.replaceAll('_', ''));
  }

  String pattern(String name) =>
      RegExp('$name = /(.+)/i?\n').firstMatch(contract)![1]!;

  test('the harnesses and their sources are the backend\'s', () {
    final markers = {
      for (final m in RegExp(
        r"'(autonomous/[a-z-]+)': '([^']+)'",
      ).allMatches(block('communityHarnessMarkers')))
        m[1]!: m[2]!,
    };
    expect(markers, isNotEmpty);
    expect(hubHarnessMarkers, markers);
  });

  test('the agents are the backend\'s', () {
    final engines = RegExp(r"'([^']+)'")
        .allMatches(block('communityEngines'))
        .map((m) => m[1]!)
        .toSet();
    expect(hubEngines.values.toSet(), engines);
  });

  test('the limits and names are the backend\'s', () {
    expect(hubMaxFiles, limit('files'));
    expect(hubMaxFileChars, limit('fileChars'));
    expect(hubMaxTurns, limit('turns'));
    expect(hubMaxTurnChars, limit('turnChars'));
    expect(hubMaxCoverChars, limit('coverChars'));
    expect(hubMaxProjectChars, lessThan(limit('snapshotBytes')));
    expect(hubReservedName.pattern, pattern('communityReservedName'));
    expect(hubReservedName.isCaseSensitive, isFalse);
    expect(hubPathPattern.pattern, pattern('communityPathPattern'));
  });
}
