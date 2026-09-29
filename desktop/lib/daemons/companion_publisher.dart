import 'dart:convert';

/// A latest-state publication, never a queue of historical animations.
class CompanionPublisher {
  CompanionPublisher({
    required this.window,
    required this.send,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final String window;
  final bool Function(Map<String, dynamic>) send;
  final DateTime Function() _now;
  String? _scope, _key;
  int _epoch = 0, _revision = 0;
  DateTime? _sent;
  bool owns(Map<String, dynamic> request) =>
      request['window'] == window && request['epoch'] == _epoch;

  void publish(
    Map<String, dynamic> presentation, {
    required String? scope,
    required bool foreground,
    bool force = false,
  }) {
    if (_scope != scope) {
      _scope = scope;
      _epoch++;
      _key = null;
    }
    final content = <String, dynamic>{
      ...presentation,
      'foreground': foreground,
    };
    // Remaining time changes on every paint, but never starts a new reaction.
    final comparable = <String, dynamic>{...content};
    if (content['feeling'] case final Map feeling) {
      comparable['feeling'] = Map<String, dynamic>.from(feeling)
        ..remove('remainingMs');
    }
    final key = jsonEncode(comparable);
    final now = _now();
    final due =
        _sent == null || now.difference(_sent!) >= const Duration(seconds: 10);
    if (!force && key == _key && !due) return;
    final payload = <String, dynamic>{
      'v': 1,
      'window': window,
      'epoch': _epoch,
      'revision': ++_revision,
      ...content,
    };
    if (send(payload)) {
      _key = key;
      _sent = now;
    }
  }
}
