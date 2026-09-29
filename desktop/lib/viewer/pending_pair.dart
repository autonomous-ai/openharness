import 'dart:convert';

import 'connect_code.dart';

/// A machine's QR opened by the phone's own camera: `https://harness.autonomous.ai/pair#…` lands in
/// the browser, which is this web app. The code is held — in the tab's sessionStorage, see
/// `pending_pair_store.dart` — across the SSO round trip, which comes back to `/` and would lose the
/// fragment, and it is taken out of the address bar at once so it is not left in history.
///
/// Pure: parsing, expiry and (de)serialising. Where it is kept is the store's business.
class PendingPair {
  const PendingPair(this.code, this.capturedAt, [this.link]);

  final ConnectCode code;
  final DateTime capturedAt;

  /// How long a scanned code is worth holding. The machine keeps its QR up and redraws a fresh one
  /// every few minutes, and a phone's intent lasts a minute once sent; a code older than this is a
  /// stale photo, and "scan it again" is the honest answer.
  static const ttl = Duration(minutes: 3);

  bool isExpired(DateTime now) => now.difference(capturedAt) >= ttl;

  /// The pair a page URL carries, or null. Any host: staging and local builds serve the same app, so
  /// the path and fragment are what matter, and the fragment is parsed as the canonical link.
  static PendingPair? fromUri(Uri base, DateTime now) {
    if (base.path != ConnectCode.path || base.fragment.isEmpty) return null;
    final canonical = Uri(
      scheme: 'https',
      host: ConnectCode.host,
      path: ConnectCode.path,
      fragment: base.fragment,
    ).toString();
    final code = ConnectCode.parse(canonical);
    // Something to link: a machine and its pairing code, or a machine asking to be signed in.
    if (code == null ||
        code.pairCode == null ||
        (code.machineId == null && !code.isSignIn)) {
      return null;
    }
    return PendingPair(code, now, canonical);
  }

  /// The link as read, so every field it carried (`s`, `h`, …) survives the round trip.
  final String? link;

  String encode() =>
      jsonEncode({'link': link, 'at': capturedAt.millisecondsSinceEpoch});

  static PendingPair? decode(String? raw) {
    if (raw == null) return null;
    try {
      final json = jsonDecode(raw);
      if (json is! Map) return null;
      final link = json['link'], at = json['at'];
      if (link is! String || at is! int) return null;
      final code = ConnectCode.parse(link);
      if (code == null) return null;
      return PendingPair(code, DateTime.fromMillisecondsSinceEpoch(at), link);
    } on FormatException {
      return null;
    }
  }
}
