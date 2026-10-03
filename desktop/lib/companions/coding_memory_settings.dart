import 'package:flutter/foundation.dart';

import 'coding_memory_connection.dart';

/// Owns an explicit local opt-in, using the same owner-verified transport as the library.
class CodingMemorySettings extends ChangeNotifier {
  CodingMemorySettings(this.openConnection);
  final CodingMemoryConnection? Function() openConnection;
  CodingMemoryConnection? _connection;
  bool enabled = false, loaded = false, saving = false, _disposed = false;
  int _revision = 0, _generation = 0;
  String? error;
  Future<void>? _reading;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _ownerChanged() {
    if (_connection?.valid != false) return;
    ++_generation;
    enabled = loaded = saving = false;
    error = 'Your account or local connection changed. Refresh this setting.';
    _notify();
  }

  Future<Map<String, dynamic>> _request(Map<String, dynamic> payload) async {
    final connection = _connection;
    if (connection == null || !connection.valid) {
      throw const CodingMemoryFailure('OWNER_CHANGED');
    }
    final response = await connection.request(payload);
    if (!connection.valid) throw const CodingMemoryFailure('OWNER_CHANGED');
    if (response['ok'] != true) {
      throw CodingMemoryFailure(
        response['error'] as String? ?? 'MEMORY_UNAVAILABLE',
      );
    }
    if (response['enabled'] is! bool || response['revision'] is! int) {
      throw const CodingMemoryFailure('UNSUPPORTED');
    }
    return response;
  }

  void _apply(Map<String, dynamic> response) {
    final revision = response['revision'] as int;
    if (revision < _revision) return;
    enabled = response['enabled'] as bool;
    _revision = revision;
    loaded = true;
    error = null;
  }

  Future<void> refresh() {
    if (_disposed || saving) return Future.value();
    return _reading ??= _read().whenComplete(() => _reading = null);
  }

  Future<void> _read() async {
    if (_connection?.valid != true) {
      _connection?.removeListener(_ownerChanged);
      _connection?.dispose();
      _connection = openConnection()?..addListener(_ownerChanged);
      _revision = 0;
      loaded = enabled = false;
    }
    final generation = _generation;
    try {
      if (_connection == null) {
        throw const CodingMemoryFailure('LOCAL_UNAVAILABLE');
      }
      final response = await _request({'action': 'experiment'});
      if (!_disposed && generation == _generation) _apply(response);
    } catch (failure) {
      if (!_disposed && generation == _generation) {
        loaded = false;
        error = _message(failure);
      }
    }
    _notify();
  }

  Future<void> setEnabled(bool value) async {
    if (_disposed || saving || !loaded || _connection?.valid != true) return;
    final generation = ++_generation;
    saving = true;
    error = null;
    _notify();
    try {
      final response = await _request({
        'action': 'configure_experiment',
        'enabled': value,
        'expected': _revision,
      });
      if (!_disposed && generation == _generation) _apply(response);
    } catch (failure) {
      if (!_disposed && generation == _generation) {
        loaded = false;
        error = '${_message(failure)} Refresh to check the saved choice.';
      }
    } finally {
      if (!_disposed && generation == _generation) saving = false;
      _notify();
    }
  }

  static String _message(Object failure) => switch (failure) {
    CodingMemoryFailure(code: 'DAEMONS_OFF') =>
      'Turn on Focus-bar creature above to use coding memory.',
    CodingMemoryFailure(code: 'UNSUPPORTED') =>
      'Update the local Harness service to use this setting.',
    CodingMemoryFailure(code: 'LOCAL_UNAVAILABLE') =>
      'Connect this computer to Harness to choose this setting.',
    CodingMemoryFailure(code: 'SETTINGS_CHANGED') =>
      'This setting changed in another window.',
    _ => codingMemoryError(failure),
  };

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _connection?.removeListener(_ownerChanged);
    _connection?.dispose();
    super.dispose();
  }
}
