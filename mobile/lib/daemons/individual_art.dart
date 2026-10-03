/// An individual's own plates, drawn by the harness background process on one
/// of your computers (harnessd, `daemons/README.md` "Individual art") and
/// asked for over the relay with the sealed `pair_plate_get` → `pair_plate`
/// frames. A phone never runs a model: until the art arrives, and whenever no
/// computer can be asked, it shows the species plate painted in the
/// individual's colour family (`CellPalette.individual`).
///
/// Seed 0 is the species' own look, which the baked species plates already
/// are: nothing is asked for it. A species without a trait catalogue (line
/// art) has no individual art.
///
/// Kept in memory only, per species, seed, size, version and mood: the art
/// follows from those alone, so every individual with the same seed shares
/// it. A request that failed is not asked again for [retryAfter].
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'plates.dart';
import 'roster.dart';
import 'zoo.dart';

/// Ask a computer for art: the `pair_plate_get` payload (without its
/// `requestId`, which the transport adds) in, the `pair_plate` payload out,
/// or null when no computer answered.
typedef PlateRequest = Future<Map<String, dynamic>?> Function(
  Map<String, dynamic> payload,
);

class IndividualArt extends ChangeNotifier {
  IndividualArt({
    required this.request,
    DaemonRoster? roster,
    DateTime Function()? now,
  }) : roster = roster ?? daemonRoster,
       _now = now ?? DateTime.now;

  final PlateRequest request;
  final DaemonRoster roster;
  final DateTime Function() _now;

  /// How long a request that got nothing waits before it is tried again.
  static const retryAfter = Duration(minutes: 5);

  /// At most this many loops are kept; the least recently drawn goes first.
  static const keep = 96;

  /// In the order drawn, least recently first (a map literal keeps order).
  final _art = <String, List<PlateFrame>>{};
  final _asking = <String, Future<void>>{};
  final _failed = <String, DateTime>{};
  bool _disposed = false;
  int _generation = 0;

  static String _key(
    String id,
    int seed,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) => '$id $seed ${size.name} $version ${mood.name}';

  /// Whether [daemon] can have art of its own: a plate species with a trait
  /// catalogue, and a seed other than 0.
  bool drawsOwn(ZooDaemon daemon) {
    final d = roster.byId(daemon.id);
    return daemon.seed != 0 && d != null && d.plate && d.traits != null;
  }

  /// [daemon]'s own loop at [size], [version] and [mood], when it has
  /// arrived; null until then (and for a daemon with none), after which it is
  /// asked for once and listeners hear when it lands.
  List<PlateFrame>? frames(
    ZooDaemon daemon,
    PlateSize size,
    String version, {
    DaemonMood mood = DaemonMood.idle,
  }) {
    if (_disposed || !drawsOwn(daemon)) return null;
    final key = _key(daemon.id, daemon.seed, size, version, mood);
    final have = _art.remove(key);
    if (have != null) {
      _art[key] = have;
      return have;
    }
    _ask(key, daemon, size, version, mood);
    return null;
  }

  /// Ask for it now (the hatch, before its reveal needs it): nothing when it
  /// is here, on its way, or recently failed.
  void prefetch(
    ZooDaemon daemon,
    PlateSize size,
    String version, {
    DaemonMood mood = DaemonMood.idle,
  }) => frames(daemon, size, version, mood: mood);

  void _ask(
    String key,
    ZooDaemon daemon,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) {
    if (_asking.containsKey(key)) return;
    final failed = _failed[key];
    if (failed != null && _now().difference(failed) < retryAfter) return;
    late Future<void> pending;
    pending = _fetch(key, daemon, size, version, mood, _generation)
        .whenComplete(() {
          if (identical(_asking[key], pending)) _asking.remove(key);
        });
    _asking[key] = pending;
  }

  Future<void> _fetch(
    String key,
    ZooDaemon daemon,
    PlateSize size,
    String version,
    DaemonMood mood,
    int generation,
  ) async {
    Map<String, dynamic>? answer;
    try {
      answer = await request({
        'uid': daemon.uid,
        'id': daemon.id,
        'seed': daemon.seed,
        'size': size.name,
        'version': version,
        'mood': mood.name,
      });
    } catch (error) {
      debugPrint('daemons: plate for ${daemon.id} ${daemon.seed}: $error');
    }
    if (_disposed || generation != _generation) return;
    final frames =
        answer == null || (answer['uid'] != null && answer['uid'] != daemon.uid)
        ? null
        : _read(answer, size, version, mood);
    if (frames == null) {
      _failed[key] = _now();
      return;
    }
    _failed.remove(key);
    _art[key] = frames;
    while (_art.length > keep) {
      _art.remove(_art.keys.first);
    }
    notifyListeners();
  }

  /// The frames of a `pair_plate` answer, or null for one that is not the
  /// art asked for or would not draw: every frame the same shape, printable
  /// ASCII, within the size's columns and rows (its species' rows plus the
  /// room an individual may take above them).
  List<PlateFrame>? _read(
    Map<String, dynamic> answer,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) {
    if (answer['error'] != null) return null;
    if (answer['size'] != null && answer['size'] != size.name) return null;
    if (answer['version'] != null && answer['version'] != version) return null;
    if (answer['mood'] != null && answer['mood'] != mood.name) return null;
    final raw = answer['frames'];
    if (raw is! List || raw.isEmpty || raw.length > 8) return null;
    final rules = roster.rules.plate;
    final cols = rules?.cols[size.name] ?? 56;
    final maxRows =
        (rules?.maxRows[size.name] ?? 24) +
        (rules?.room ?? 0) * (size == PlateSize.reveal ? 2 : 1);
    final frames = <PlateFrame>[];
    int? width, height;
    for (final f in raw) {
      if (f is! Map || f['rows'] is! String || f['mats'] is! String) {
        return null;
      }
      final rows = (f['rows'] as String).split('\n');
      final mats = (f['mats'] as String).split('\n');
      if (rows.length != mats.length) return null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].length != mats[i].length ||
            !RegExp(r'^[.magse p]*$').hasMatch(mats[i])) {
          return null;
        }
      }
      final frame = PlateFrame.parse(f['rows'] as String, f['mats'] as String?);
      height ??= frame.rows.length;
      width ??= frame.rows.first.length;
      if (frame.rows.length != height || height > maxRows) return null;
      for (final row in frame.rows) {
        if (row.length != width || width > cols || !_printable.hasMatch(row)) {
          return null;
        }
      }
      frames.add(frame);
    }
    return List.unmodifiable(frames);
  }

  static final _printable = RegExp(r'^[\x20-\x7e]*$');

  /// Signed out: nothing more is asked, and what failed may be asked again.
  void reset() {
    _generation++;
    _asking.clear();
    _art.clear();
    _failed.clear();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
