// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'package:flutter/foundation.dart';

/// What each agent needs from a person, as the local daemon's `attention` frame reports it
/// (cli/src/lib/attention.ts). Its own notifier, like [DialState], so a state change only
/// rebuilds the panes that draw it.
enum AgentAttention { working, waiting, permission, failed, done, idle, offline }

AgentAttention attentionFromWire(Object? v) => switch (v) {
      'working' => AgentAttention.working,
      'waiting' => AgentAttention.waiting,
      'permission' => AgentAttention.permission,
      'failed' => AgentAttention.failed,
      'done' => AgentAttention.done,
      'offline' => AgentAttention.offline,
      _ => AgentAttention.idle,
    };

/// Same glyphs and words as cli/src/lib/attention.ts (ATTENTION_GLYPH, ATTENTION_LABEL).
String attentionGlyph(AgentAttention s) => switch (s) {
      AgentAttention.working => '~',
      AgentAttention.waiting => '?',
      AgentAttention.permission => '!',
      AgentAttention.failed => 'x',
      AgentAttention.done => '*',
      AgentAttention.idle => '-',
      AgentAttention.offline => '.',
    };

String attentionLabel(AgentAttention s) => switch (s) {
      AgentAttention.working => 'working',
      AgentAttention.waiting => 'waiting on you',
      AgentAttention.permission => 'needs permission',
      AgentAttention.failed => 'failed',
      AgentAttention.done => 'done, unreviewed',
      AgentAttention.idle => 'idle',
      AgentAttention.offline => 'offline',
    };

@immutable
class AttentionRow {
  const AttentionRow({
    required this.agentId,
    required this.state,
    this.detail = '',
    this.spendFraction,
    this.spendUsd,
    this.name = '',
    this.machine = '',
    this.lane,
  });
  final String agentId;
  final AgentAttention state;
  final String detail;
  final double? spendFraction;
  final double? spendUsd;

  /// Display name, host name and policy lane as the daemon sends them (empty or null when absent).
  final String name;
  final String machine;
  final String? lane;

  /// The glyph and word every state carries so colour is never the only signal (design/attention-motion.md).
  String get glyph => attentionGlyph(state);
  String get label => attentionLabel(state);

  /// Needs a person now: the pane glows for these and only these.
  bool get needsYou => state == AgentAttention.waiting || state == AgentAttention.permission || state == AgentAttention.failed;

  // Value equality, so an identical frame (one arrives every second) does not repaint every pane.
  @override
  bool operator ==(Object other) =>
      other is AttentionRow &&
      other.agentId == agentId &&
      other.state == state &&
      other.detail == detail &&
      other.spendFraction == spendFraction &&
      other.spendUsd == spendUsd &&
      other.name == name &&
      other.machine == machine &&
      other.lane == lane;

  @override
  int get hashCode => Object.hash(agentId, state, detail, spendFraction, spendUsd, name, machine, lane);
}

class AttentionState extends ChangeNotifier {
  final Map<String, AttentionRow> _rows = {};

  AttentionRow? of(String agentId) => _rows[agentId];

  /// Every row from the last frame, in the daemon's priority order.
  Iterable<AttentionRow> get rows => _rows.values;

  /// The host that sent the last frame (`hostname` on the payload), empty before the first one.
  String get hostname => _hostname;
  String _hostname = '';

  /// Replace from one `attention` frame payload. Unknown shapes are ignored, never thrown.
  void apply(Map<String, dynamic> payload) {
    final agents = payload['agents'];
    if (agents is! List) return;
    final next = <String, AttentionRow>{};
    for (final a in agents) {
      if (a is! Map) continue;
      final id = a['agentId'];
      if (id is! String || id.isEmpty) continue;
      final spend = a['spend'];
      String str(Object? v) => v is String ? v : '';
      next[id] = AttentionRow(
        agentId: id,
        state: attentionFromWire(a['state']),
        detail: str(a['detail']),
        spendFraction: spend is Map && spend['fraction'] is num ? (spend['fraction'] as num).toDouble() : null,
        spendUsd: spend is Map && spend['usd'] is num ? (spend['usd'] as num).toDouble() : null,
        name: str(a['name']),
        machine: str(a['machine']),
        lane: a['lane'] is String ? a['lane'] as String : null,
      );
    }
    final host = payload['hostname'] is String ? payload['hostname'] as String : _hostname;
    if (mapEquals(_rows, next) && host == _hostname) return;
    _hostname = host;
    _rows
      ..clear()
      ..addAll(next);
    notifyListeners();
  }
}
