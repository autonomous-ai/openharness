import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

typedef TeamRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic>,
);

String teamOperationId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

class TeamRequestError implements Exception {
  const TeamRequestError(this.message, {this.uncertain = false});
  final String message;
  final bool uncertain;
  @override
  String toString() => message;
}

List<Map<String, dynamic>> teamRows(dynamic value) => [
  for (final row in value is List ? value : const [])
    if (row is Map) Map<String, dynamic>.from(row),
];

/// A view of daemon-owned work. Closing Team only releases its read subscription.
/// Uncertain operations and drafts belong here, so reopening cannot duplicate a send.
class TeamController extends ChangeNotifier {
  TeamController({
    required this.request,
    this.channelTabId,
    this.pollInterval = const Duration(seconds: 3),
  });
  final TeamRequest request;
  final String? channelTabId;
  bool get isChannel => channelTabId != null || team?['channel'] != null;
  final Duration pollInterval;
  List<Map<String, dynamic>> teams = [];
  Map<String, dynamic>? team;
  String? selectedId, error;
  bool loading = true, operating = false;
  String draft = '', newName = 'Build together', newDescription = '';
  String? from, to, selectedExchange;
  final Map<String, Map<String, dynamic>> newMembers = {};
  Map<String, dynamic>? _createAttempt;
  final _askAttempts = <String, Map<String, dynamic>>{};
  final _addAttempts = <String, Map<String, dynamic>>{};
  final _consultAttempts = <String, Map<String, dynamic>>{};
  final _consultFlights = <String, Future<String>>{};
  final _drafts =
      <String, ({String text, String? from, String? to, String? exchange})>{};
  Timer? _timer;
  int _readers = 0, _epoch = 0;
  bool _disposed = false;
  Future<void>? _refresh;
  bool get pendingCreate => _createAttempt != null;
  bool get pendingAsk => _askAttempts.containsKey(selectedId);
  bool get pendingAdd => _addAttempts.containsKey(selectedId);
  List<Map<String, dynamic>> get members => teamRows(team?['members']);
  List<Map<String, dynamic>> get exchanges {
    final rows = [...teamRows(team?['exchanges']).reversed];
    if (isChannel) {
      rows.sort(
        (a, b) => ((b['createdAt'] as num?) ?? 0).compareTo(
          (a['createdAt'] as num?) ?? 0,
        ),
      );
    }
    return rows;
  }

  bool get active => team?['state'] == 'active';

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void watch() {
    if (_disposed || _readers++ > 0) return;
    unawaited(refresh());
    _timer = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
  }

  void unwatch() {
    if (_readers > 0) _readers--;
    if (_readers == 0) {
      _timer?.cancel();
      _timer = null;
    }
  }

  void changed() {
    if (_readers > 0) unawaited(refresh());
  }

  Future<Map<String, dynamic>> _call(Map<String, dynamic> payload) async {
    final result = await request(payload);
    if (result['error'] != null) {
      throw TeamRequestError(
        result['detail']?.toString() ?? result['error'].toString(),
        uncertain: const {
          'UNCONFIRMED',
          'DISCONNECTED',
          'TEAM_UNAVAILABLE',
        }.contains(result['error']),
      );
    }
    return result;
  }

  Future<void> refresh() =>
      _refresh ??= _read().whenComplete(() => _refresh = null);
  Future<void> _read() async {
    final epoch = _epoch, id = selectedId;
    try {
      final result = await _call({
        'action': channelTabId != null
            ? 'channel_get'
            : id == null
            ? 'list'
            : 'get',
        if (channelTabId != null) 'tabId': channelTabId else 'teamId': ?id,
      });
      if (_disposed || epoch != _epoch) return;
      if (channelTabId != null) {
        selectedId = (result['team'] as Map?)?['id'] as String?;
        _apply(result['team']);
        error = null;
      } else if (id == null) {
        teams = teamRows(result['teams']);
        final faults = teamRows(result['errors']);
        error = faults.isEmpty
            ? null
            : faults.map((f) => f['detail']).join('\n');
      } else {
        _apply(result['team']);
        error = null;
      }
    } catch (e) {
      if (!_disposed && epoch == _epoch) error = e.toString();
    }
    if (!_disposed && epoch == _epoch) {
      loading = false;
      _notify();
    }
  }

  void _apply(dynamic value) {
    if (_disposed || value is! Map || value['id'] != selectedId) return;
    if (team?['id'] == value['id'] &&
        (team?['revision'] as num? ?? 0) > (value['revision'] as num? ?? 0)) {
      return;
    }
    team = Map<String, dynamic>.from(value);
    if (isChannel && selectedExchange == null && exchanges.isNotEmpty) {
      selectedExchange = exchanges.first['id'] as String?;
    }
    final enabled = members.where((m) => m['enabled'] != false).toList();
    if (!enabled.any((m) => m['id'] == from)) {
      from = enabled.firstOrNull?['id'] as String?;
    }
    if (!enabled.any((m) => m['id'] == to) || from == to) {
      to = enabled.where((m) => m['id'] != from).firstOrNull?['id'] as String?;
    }
  }

  Future<void> select(String? id) async {
    if (selectedId case final current?) {
      _drafts[current] = (
        text: draft,
        from: from,
        to: to,
        exchange: selectedExchange,
      );
    }
    _epoch++;
    selectedId = id;
    team = null;
    final saved = _drafts[id];
    draft = saved?.text ?? '';
    from = saved?.from;
    to = saved?.to;
    selectedExchange = saved?.exchange;
    error = null;
    loading = true;
    _notify();
    // A slow reply for the previous team must not hold up the newly selected one.
    await _read();
  }

  void edit() => _notify();

  /// The caller captures tab and agent before any await. Retries retain that
  /// instruction's identity, even after focus changes or the view is closed.
  Future<String> consult(String machineId, String agentId) {
    final key = '$machineId/$agentId';
    return _consultFlights[key] ??= _consult(machineId, agentId, key)
        .whenComplete(() {
          _consultFlights.remove(key);
        });
  }

  Future<String> _consult(String machineId, String agentId, String key) async {
    if (channelTabId == null) return 'Choose a tab first.';
    final attempt = _consultAttempts.putIfAbsent(
      key,
      () => {
        'action': 'channel_consult',
        'tabId': channelTabId,
        'id': teamOperationId(),
        'from': {'machineId': machineId, 'agentId': agentId},
      },
    );
    try {
      final result = await _call(attempt);
      if (_disposed) return 'Tab instruction sent.';
      _consultAttempts.remove(key);
      error = null;
      final receipt = (result['consultation'] as Map?)?['receipt'] as Map?;
      _notify();
      return 'Consult tab · ${teamDeliveryLabel(receipt?.cast<String, dynamic>())}';
    } catch (e) {
      if (e is TeamRequestError && !e.uncertain) _consultAttempts.remove(key);
      final message =
          '$e${_consultAttempts.containsKey(key) ? ' Retry consult to check the same instruction.' : ''}';
      if (!_disposed) {
        error = message;
        _notify();
      }
      return message;
    }
  }

  Future<void> create() async {
    if (operating) return;
    _createAttempt ??= {
      'action': 'create',
      'id': teamOperationId(),
      'name': newName.trim(),
      'description': newDescription.trim(),
      'members': newMembers.values
          .map((m) => Map<String, dynamic>.from(m))
          .toList(),
    };
    operating = true;
    error = null;
    _notify();
    try {
      final result = await _call(_createAttempt!);
      if (_disposed) return;
      final created = result['team'] as Map;
      selectedId = created['id'] as String;
      _epoch++;
      _apply(created);
      _createAttempt = null;
      newMembers.clear();
      loading = false;
    } catch (e) {
      if (e is TeamRequestError && !e.uncertain) _createAttempt = null;
      error =
          '$e${_createAttempt != null ? '\nCheck connection retries this same team.' : ''}';
    } finally {
      operating = false;
      _notify();
    }
  }

  Future<void> ask() async {
    if (operating ||
        selectedId == null ||
        (!pendingAsk &&
            (draft.trim().isEmpty ||
                from == null ||
                to == null ||
                from == to))) {
      return;
    }
    final id = selectedId!;
    final attempt = _askAttempts.putIfAbsent(
      id,
      () => {
        'action': 'ask',
        'teamId': id,
        'id': teamOperationId(),
        'from': from,
        'to': to,
        'text': draft.trim(),
      },
    );
    operating = true;
    error = null;
    _notify();
    try {
      final result = await _call(attempt);
      if (_disposed) return;
      if (id == selectedId) {
        selectedExchange = (result['exchange'] as Map)['id'] as String;
        draft = '';
      } else if (_drafts[id] case final saved?) {
        _drafts[id] = (
          text: '',
          from: saved.from,
          to: saved.to,
          exchange: (result['exchange'] as Map)['id'] as String,
        );
      }
      _askAttempts.remove(id);
      await _read();
    } catch (e) {
      if (e is TeamRequestError && !e.uncertain) _askAttempts.remove(id);
      error =
          '$e${_askAttempts.containsKey(id) ? '\nCheck send uses the same question ID.' : ''}';
    } finally {
      operating = false;
      _notify();
    }
  }

  Future<void> addMember([Map<String, dynamic>? member]) async {
    if (operating || selectedId == null || (!pendingAdd && member == null)) {
      return;
    }
    final id = selectedId!;
    final attempt = _addAttempts.putIfAbsent(
      id,
      () => {
        'action': 'add_member',
        'teamId': id,
        'member': {...member!, 'id': teamOperationId()},
      },
    );
    operating = true;
    error = null;
    _notify();
    try {
      final result = await _call(attempt);
      if (_disposed) return;
      if (id == selectedId) _apply(result['team']);
      _addAttempts.remove(id);
    } catch (e) {
      if (e is TeamRequestError && !e.uncertain) _addAttempts.remove(id);
      error =
          '$e${_addAttempts.containsKey(id) ? '\nCheck teammate retries this same membership.' : ''}';
    } finally {
      operating = false;
      _notify();
    }
  }

  Future<void> act(
    String action, [
    Map<String, dynamic> values = const {},
  ]) async {
    if (operating || selectedId == null) return;
    final id = selectedId;
    operating = true;
    error = null;
    _notify();
    try {
      final result = await _call({'action': action, 'teamId': id, ...values});
      if (!_disposed && id == selectedId) {
        _apply(result['team']);
        await _read();
      }
    } catch (e) {
      error = e.toString();
    } finally {
      operating = false;
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _timer?.cancel();
    super.dispose();
  }
}

String teamDeliveryLabel(Map<String, dynamic>? receipt) =>
    switch (receipt?['state']) {
      'pending' => 'Waiting to deliver',
      'queued' =>
        receipt?['reason'] == 'team_waiting_draft'
            ? 'Waiting for draft'
            : receipt?['reason'] == 'team_waiting_user'
            ? 'Waiting for user'
            : 'Queued',
      'submitted' => 'Confirming delivery',
      'delivered' => 'Delivered',
      'started' => 'Agent accepted input',
      'received' => 'Read in inbox',
      'unknown' => 'Delivery unconfirmed',
      'rejected' => 'Delivery failed',
      'cancelled' => 'Notice cancelled',
      _ => 'Not sent',
    };
