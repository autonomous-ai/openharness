import 'package:flutter/foundation.dart';

/// A small, semantic remote for an existing form. The widget owns all choices
/// and actions; the device never manufactures keystrokes or creation requests.
class DeviceFormPort {
  DeviceFormPort({this.explicitGuard = false});

  /// A live finder may refresh status text while its selected identity stays
  /// fixed. Its guard includes the actual action target and editing context.
  final bool explicitGuard;
  Map<String, dynamic> Function()? _read;
  void Function(String op, int delta, String? text)? _act;
  Map<String, dynamic>? _last;
  int _revision = 0;
  ({String id, int revision})? _query;

  void attach(
    Map<String, dynamic> Function() read,
    void Function(String op, int delta, String? text) act,
  ) {
    _read = read;
    _act = act;
  }

  void detach() {
    _read = null;
    _act = null;
    _query = null;
  }

  Map<String, dynamic> snapshot() {
    final next = _read?.call() ?? {'active': false};
    final previous = _last ?? const <String, dynamic>{};
    final changed = explicitGuard
        ? next['active'] != previous['active'] ||
              next['guard'] != previous['guard']
        : !mapEquals(next, _last);
    if (changed) {
      _revision++;
      _query = null;
    }
    _last = next;
    return {'ok': true, ...next, 'revision': _revision}..remove('guard');
  }

  Map<String, dynamic> command(
    String op,
    int revision,
    int delta, {
    String? queryId,
    String? text,
  }) {
    final before = snapshot();
    if (op == 'state' || before['active'] != true) return before;
    if (op == 'query.cancel') {
      if (_query?.id == queryId) _query = null;
      return before;
    }
    if (revision != _revision) {
      return {...before, 'ok': false, 'error': 'Choices changed. Try again.'};
    }
    if (op == 'query.begin') {
      if (before['canQuery'] != true || queryId == null) {
        return {
          ...before,
          'ok': false,
          'error': 'Choose an Agent or Project field to search.',
        };
      }
      _query = (id: queryId, revision: revision);
      return {...before, 'queryId': queryId};
    }
    if (op == 'query') {
      if (_query?.id != queryId ||
          _query?.revision != revision ||
          before['canQuery'] != true ||
          text == null ||
          text.trim().isEmpty) {
        return {
          ...before,
          'ok': false,
          'error': 'The voice search ended. Say the name again.',
        };
      }
      _query = null; // single use, including when applying the same query twice
    }
    _act?.call(op, delta, text);
    return snapshot();
  }
}
