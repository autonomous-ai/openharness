import 'package:flutter/foundation.dart';

import 'team_controller.dart';

/// The account's explicit opt-in. An absent, unreadable, or not-yet-loaded choice
/// never enables collaboration. The daemon enforces the same gate independently.
class SwarmSettingsController extends ChangeNotifier {
  SwarmSettingsController({required this.request});
  final TeamRequest request;
  bool enabled = false, loaded = false, saving = false;
  String? error;
  int _epoch = 0, _revision = -1;
  bool _disposed = false;
  Future<void>? _reading;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<Map<String, dynamic>> _call(Map<String, dynamic> payload) async {
    final result = await request(payload);
    if (result['error'] != null) {
      throw TeamRequestError(
        result['detail']?.toString() ?? result['error'].toString(),
      );
    }
    if (result['enabled'] is! bool || result['revision'] is! num) {
      throw const TeamRequestError(
        'Update Harness to configure tab collaboration.',
      );
    }
    return result;
  }

  void _apply(Map<String, dynamic> result) {
    final revision = (result['revision'] as num).toInt();
    if (revision < _revision) return;
    _revision = revision;
    enabled = result['enabled'] == true;
    loaded = true;
    error = null;
  }

  Future<void> refresh() => _reading ??= _read().whenComplete(() {
    _reading = null;
  });

  Future<void> _read() async {
    final epoch = _epoch;
    try {
      final result = await _call({'action': 'channel_settings'});
      if (!_disposed && epoch == _epoch) _apply(result);
    } catch (e) {
      if (!_disposed && epoch == _epoch) error = e.toString();
    }
    _notify();
  }

  Future<void> setEnabled(bool value) async {
    if (_disposed || saving || !loaded) return;
    final epoch = ++_epoch;
    saving = true;
    error = null;
    _notify();
    try {
      final result = await _call({
        'action': 'channel_configure',
        'enabled': value,
      });
      if (!_disposed && epoch == _epoch) _apply(result);
    } catch (e) {
      if (!_disposed && epoch == _epoch) {
        error = '$e Refresh to check whether the change was saved.';
      }
    }
    if (!_disposed && epoch == _epoch) saving = false;
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
