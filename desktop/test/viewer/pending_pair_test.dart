import 'package:flutter_test/flutter_test.dart';
import 'package:harness/viewer/connect_code.dart';
import 'package:harness/viewer/pending_pair.dart';

/// A machine's QR opened by a phone's camera lands here as `/pair#…`; the web app holds the code
/// across sign-in. These are the rules for what it holds, and for how long.
void main() {
  final t0 = DateTime(2026, 9, 28, 12);
  final link = ConnectCode.link(
    'dee@x.ai',
    machineId: 'a' * 32,
    pairCode: 'ABCDEFGHJKMNPQRS',
    fingerprint: '5F8061C46142ADCF',
    hostname: 'box 2',
  );

  test(
    'any host serving the app takes a /pair link; the fragment is the code',
    () {
      for (final host in [
        'harness.autonomous.ai',
        'localhost:8080',
        'stag.harness.example',
      ]) {
        final base = Uri.parse(
          link.replaceFirst('harness.autonomous.ai', host),
        );
        final pending = PendingPair.fromUri(base, t0)!;
        expect(pending.code.machineId, 'a' * 32);
        expect(pending.code.pairCode, 'ABCDEFGHJKMNPQRS');
        expect(pending.code.fingerprint, '5F8061C46142ADCF');
        expect(pending.code.hostname, 'box 2');
      }
    },
  );

  test('anything else is not a pending pair', () {
    expect(
      PendingPair.fromUri(Uri.parse('https://harness.autonomous.ai/'), t0),
      isNull,
    );
    expect(
      PendingPair.fromUri(
        Uri.parse('https://harness.autonomous.ai/s/abc#key=x'),
        t0,
      ),
      isNull,
    );
    // A code that cannot pair (no machine or no pairing code) is not held.
    expect(
      PendingPair.fromUri(Uri.parse(ConnectCode.link('dee@x.ai')), t0),
      isNull,
    );
    expect(
      PendingPair.fromUri(
        Uri.parse('https://harness.autonomous.ai/pair#junk'),
        t0,
      ),
      isNull,
    );
  });

  test('survives the sign-in round trip, and goes stale after its window', () {
    final pending = PendingPair.fromUri(Uri.parse(link), t0)!;
    final back = PendingPair.decode(pending.encode())!;
    expect(back.code.fingerprint, '5F8061C46142ADCF');
    expect(back.capturedAt, t0);
    expect(back.isExpired(t0.add(const Duration(minutes: 2))), isFalse);
    expect(back.isExpired(t0.add(PendingPair.ttl)), isTrue);
    expect(PendingPair.decode(null), isNull);
    expect(PendingPair.decode('not json'), isNull);
  });
}
