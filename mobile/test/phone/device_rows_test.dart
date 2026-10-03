import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/device_rows.dart';

import 'devices_fixture.dart';

/// The rules of the Your devices list on the phone: who goes where, and what a row says.
void main() {
  final now = DateTime(2026, 10, 1, 12);
  int ago(Duration d) => now.subtract(d).millisecondsSinceEpoch;
  final hexGroup = RegExp(r'[0-9A-F]{4}·[0-9A-F]{4}');

  group('orderDeviceRows', () {
    test('new devices first (newest first), then the rest by last activity, '
        'falling back to when added; this phone is not listed', () {
      final self = row(
        member(
          pubOf(0),
          label: 'This phone',
          addedAt: ago(const Duration(days: 100)),
        ),
        self: true,
      );
      final oldA = row(
        member(pubOf(1), addedAt: ago(const Duration(days: 90))),
      );
      final new1 = row(member(pubOf(2), addedAt: ago(const Duration(days: 2))));
      final oldB = row(
        member(pubOf(3), addedAt: ago(const Duration(days: 80))),
      );
      final new2 = row(member(pubOf(4), addedAt: ago(const Duration(days: 1))));
      final out = orderDeviceRows(
        [oldA, self, new1, oldB, new2],
        {pubOf(1): ago(const Duration(days: 10))},
        {pubOf(2), pubOf(4)},
      );
      expect(out, [new2, new1, oldA, oldB]);
    });

    test(
      'a device recently added but not in the new set is ordered by activity',
      () {
        final recent = row(
          member(pubOf(1), addedAt: ago(const Duration(days: 1))),
        );
        final seenToday = row(
          member(pubOf(2), addedAt: ago(const Duration(days: 300))),
        );
        final out = orderDeviceRows(
          [recent, seenToday],
          {pubOf(2): ago(const Duration(hours: 1))},
          const {},
        );
        expect(out, [seenToday, recent]);
      },
    );

    test('ties keep log order', () {
      final at = ago(const Duration(days: 30));
      final rows = [
        for (var i = 1; i <= 12; i++) row(member(pubOf(i), addedAt: at)),
      ];
      expect(orderDeviceRows(rows, const {}, const {}), rows);
      final newRows = orderDeviceRows(rows, const {}, {
        for (final r in rows) r.member.pub,
      });
      expect(newRows, rows);
    });
  });

  test('selfRow finds this phone, or nothing', () {
    final self = row(member(pubOf(0), addedAt: 0), self: true);
    final other = row(member(pubOf(1), addedAt: 0));
    expect(selfRow([other, self]), same(self));
    expect(selfRow([other]), isNull);
  });

  test(
    'sharedNames: trimmed, empty names count as one, and this phone counts',
    () {
      final rows = [
        row(member(pubOf(0), label: 'iPhone', addedAt: 0), self: true),
        row(member(pubOf(1), label: 'iPhone ', addedAt: 0)),
        row(member(pubOf(2), label: '', addedAt: 0)),
        row(member(pubOf(3), label: '  ', addedAt: 0)),
        row(member(pubOf(4), label: 'MacBook', addedAt: 0)),
      ];
      expect(sharedNames(rows), {'iPhone', ''});
    },
  );

  group('deviceDetailLine', () {
    final app = row(
      member(pubOf(1), label: 'iPad', addedAt: ago(const Duration(days: 21))),
    );
    final computer = row(
      member(
        pubOf(2),
        label: 'mbp',
        kind: 'machine',
        machineId: 'abcdef123456',
        addedAt: ago(const Duration(days: 40)),
      ),
    );

    test(
      'kind and activity, and no part of the key code for a unique name',
      () {
        final seen4m = ago(const Duration(minutes: 4));
        expect(
          deviceDetailLine(computer, seen4m, now, sameName: false),
          'Computer · active now',
        );
        expect(
          deviceDetailLine(
            app,
            ago(const Duration(days: 2)),
            now,
            sameName: false,
          ),
          'App · last active 2 days ago',
        );
        expect(
          deviceDetailLine(app, null, now, sameName: false),
          'App · added 3 weeks ago',
        );
        expect(
          deviceDetailLine(
            computer,
            ago(const Duration(minutes: 5)),
            now,
            sameName: false,
          ),
          'Computer · last active 5 minutes ago',
        );
        for (final line in [
          deviceDetailLine(app, null, now, sameName: false),
          deviceDetailLine(computer, seen4m, now, sameName: false),
        ]) {
          expect(line, isNot(contains(hexGroup)));
          expect(line, isNot(contains(RegExp(r'\d{4}-\d{2}-\d{2}'))));
        }
      },
    );

    test(
      'a shared name ends in the first group of the key code and an ellipsis',
      () {
        final line = deviceDetailLine(app, null, now, sameName: true);
        final first = app.fingerprint.split('·').first;
        expect(line, 'App · added 3 weeks ago · $first…');
        expect(line, isNot(contains(hexGroup)));
      },
    );
  });
}
