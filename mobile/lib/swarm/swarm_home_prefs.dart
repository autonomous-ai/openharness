import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'swarm_home_list.dart';

/// What the person chose for Swarm Home on this phone (Tony, 2026-10-29):
/// the projects pinned at its top ([pins]), and the one Swarm it shows
/// ([swarmId]; none shows them all). Neither the server nor the desktop has
/// pins, so they stay on this phone, under the account ([store]): ids only,
/// nothing read of a Swarm, and at most [keptPins]. A Swarm the account no
/// longer has takes its pins and its choice with it ([keepOnly]).
class SwarmHomePrefs extends ChangeNotifier {
  SwarmHomePrefs({required this.accountId, this.store}) {
    unawaited(_load());
  }

  /// The most pins kept; the oldest goes first.
  static const keptPins = 50;

  final String accountId;

  /// Where the choices are kept; null keeps them in memory only.
  final LocalKeyValueStore? store;

  String get _key => 'swarm_home.$accountId';

  /// The projects pinned, by [swarmHomeProjectKey], oldest first.
  Set<String> get pins => Set.unmodifiable(_pins);
  final _pins = <String>{};

  /// The one Swarm Home shows; null for all of them.
  String? get swarmId => _swarmId;
  String? _swarmId;

  /// Something was chosen before the choices were read back: it is kept
  /// with what was read, and written only then, so as not to write over it.
  bool _touched = false;

  /// The choices were read back (or there is nowhere to read them from).
  late bool _loaded = store == null;
  bool _disposed = false;

  bool pinned(String swarmId, String projectId) =>
      _pins.contains(swarmHomeProjectKey(swarmId, projectId));

  /// Pins [projectId] of [swarmId] at Home's top ([on]), or takes it off.
  void pin(String swarmId, String projectId, bool on) {
    final key = swarmHomeProjectKey(swarmId, projectId);
    if (on ? !_pins.add(key) : !_pins.remove(key)) return;
    while (_pins.length > keptPins) {
      _pins.remove(_pins.first);
    }
    _changed();
  }

  /// Home shows Swarm [swarmId] alone; null shows them all.
  void show(String? swarmId) {
    if (_swarmId == swarmId) return;
    _swarmId = swarmId;
    _changed();
  }

  /// The account's Swarms are [swarmIds]: the pins and the choice of any
  /// other go, from the phone too.
  void keepOnly(Set<String> swarmIds) {
    final before = _pins.length;
    _pins.removeWhere((key) => !swarmIds.contains(key.split('/').first));
    final gone = _swarmId != null && !swarmIds.contains(_swarmId);
    if (gone) _swarmId = null;
    if (gone || _pins.length != before) _changed();
  }

  void _changed() {
    _touched = true;
    if (_disposed) return;
    notifyListeners();
    if (_loaded) unawaited(_save());
  }

  Future<void> _load() async {
    final store = this.store;
    if (store == null) return;
    String? text;
    try {
      text = await store.read(_key);
    } catch (_) {
      // Unreadable: nothing chosen, as on a new phone.
    }
    if (_disposed) return;
    _loaded = true;
    final (pins, swarmId) = text == null
        ? (const <String>[], null)
        : _decode(text);
    if (_touched) {
      // Chosen meanwhile: the pins join those read, oldest first, and the
      // Swarm chosen stands.
      final mine = [..._pins];
      _pins
        ..clear()
        ..addAll(pins)
        ..addAll(mine);
      while (_pins.length > keptPins) {
        _pins.remove(_pins.first);
      }
      unawaited(_save());
    } else {
      _pins
        ..clear()
        ..addAll(pins);
      _swarmId = swarmId;
    }
    notifyListeners();
  }

  static (List<String>, String?) _decode(String text) {
    try {
      final json = jsonDecode(text);
      if (json is! Map) return (const [], null);
      return (
        [
          for (final pin in json['pins'] is List ? json['pins'] as List : [])
            if (pin is String && pin.contains('/')) pin,
        ],
        json['swarm'] is String ? json['swarm'] as String : null,
      );
    } on FormatException {
      return (const [], null);
    }
  }

  Future<void> _save() async {
    final store = this.store;
    if (store == null) return;
    try {
      if (_pins.isEmpty && _swarmId == null) {
        await store.delete(_key);
      } else {
        await store.write(
          _key,
          jsonEncode({
            'pins': [..._pins],
            'swarm': ?_swarmId,
          }),
        );
      }
    } catch (_) {
      // Kept in memory; written with the next choice.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
