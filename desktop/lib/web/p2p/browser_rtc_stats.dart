import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart';

import 'terminal_p2p_link.dart';

/// Which path ICE nominated, read from the browser's stats: the transport's
/// `selectedCandidatePairId` (Chrome, Safari), else the nominated pair that
/// succeeded (Firefox reports no transport). Null when there is no pair yet.
Future<TerminalP2pTransport?> nominatedTransport(RTCPeerConnection pc) async {
  final byId = <String, JSObject>{};
  final report = await pc.getStats().toDart;
  report.callMethod<JSAny?>(
    'forEach'.toJS,
    ((JSObject value, JSString key) {
      byId[key.toDart] = value;
    }).toJS,
  );
  final pair = _selectedPair(byId) ?? _nominatedPair(byId);
  if (pair == null) return null;
  String? typeOf(String? id) =>
      id == null ? null : _string(byId[id], 'candidateType');
  return isRelayedPair(
        typeOf(_string(pair, 'localCandidateId')),
        typeOf(_string(pair, 'remoteCandidateId')),
      )
      ? TerminalP2pTransport.relay
      : TerminalP2pTransport.direct;
}

JSObject? _selectedPair(Map<String, JSObject> byId) {
  for (final stats in byId.values) {
    if (_string(stats, 'type') != 'transport') continue;
    final selected = _string(stats, 'selectedCandidatePairId');
    if (selected != null && byId[selected] != null) return byId[selected];
  }
  return null;
}

JSObject? _nominatedPair(Map<String, JSObject> byId) {
  for (final stats in byId.values) {
    if (_string(stats, 'type') != 'candidate-pair') continue;
    final state = _string(stats, 'state');
    if (stats.getProperty<JSAny?>('nominated'.toJS).dartify() == true &&
        (state == 'succeeded' || state == 'in-progress')) {
      return stats;
    }
  }
  return null;
}

String? _string(JSObject? stats, String key) {
  final value = stats?.getProperty<JSAny?>(key.toJS);
  return value != null && value.isA<JSString>()
      ? (value as JSString).toDart
      : null;
}
