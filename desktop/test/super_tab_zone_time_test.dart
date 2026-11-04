import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/zone_time.dart';

/// A person's card shows the time where they are, from their zone's name, so
/// daylight saving stays right (River, 11-04); a zone it cannot read gives no
/// time rather than a guess.
void main() {
  test('Asia/Ho_Chi_Minh at 08:42Z is 15:42', () async {
    expect(
      await superTabTimeIn('Asia/Ho_Chi_Minh', DateTime.utc(2026, 11, 4, 8, 42)),
      const TimeOfDay(hour: 15, minute: 42),
    );
  });

  test('New York keeps daylight saving', () async {
    expect(
      await superTabTimeIn('America/New_York', DateTime.utc(2026, 7, 1, 16)),
      const TimeOfDay(hour: 12, minute: 0),
    );
    expect(
      await superTabTimeIn('America/New_York', DateTime.utc(2026, 12, 1, 17)),
      const TimeOfDay(hour: 12, minute: 0),
    );
  });

  test('unknown zone gives no time', () async {
    expect(
      await superTabTimeIn('Mars/Base', DateTime.utc(2026, 11, 4)),
      isNull,
    );
  });

  test('no zone gives no time', () async {
    expect(await superTabTimeIn(null, DateTime.utc(2026, 11, 4)), isNull);
  });
}
