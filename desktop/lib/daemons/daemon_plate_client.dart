/// An individual's own plates, drawn on this computer by the harness
/// background process (the docs call it harnessd) with the shared shader and
/// models (`daemons/README.md`, "Individual art"), and asked for over the
/// local socket like the other `daemon_*` frames:
///
///   `daemon_plate_get { requestId, uid, id, seed, size, version, mood }`
///   -> `daemon_plate { requestId, uid, size, version, mood,
///                      frames: [{ rows, mats }], frameMs }`
///   or `daemon_plate { requestId, error }`.
///
/// Until an individual's art arrives, and whenever the harness process
/// cannot be reached, the window shows the species plate painted in the
/// individual's colour family. A seed of 0 is the species as it was drawn
/// before individuals: its species plate is its own, so it is never asked
/// for.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'plates.dart';
import 'roster.dart';
import 'zoo.dart';

/// One loop of an individual's own plate: frames with their material rows
/// (`m` a marking, `a` its extra, `e` the odd eye), and how long each shows.
@immutable
class DaemonIndividualArt {
  const DaemonIndividualArt(this.frames, this.frameMs);
  final List<PlateFrame> frames;
  final int frameMs;
}

class DaemonPlateClient extends ChangeNotifier {
  DaemonPlateClient({
    required this.send,
    DaemonRoster? roster,
    this.answerWithin = const Duration(minutes: 2),
    this.retryAfter = const Duration(minutes: 1),
    DateTime Function()? now,
  }) : roster = roster ?? daemonRoster,
       _now = now ?? DateTime.now;

  /// Sends a frame on the socket bound to this computer's own harness
  /// process; false when there is none.
  final bool Function(String type, Map<String, dynamic> payload) send;
  final DaemonRoster roster;

  /// A request not answered by then is given up (the species plate stays).
  final Duration answerWithin;

  /// A request that failed, or had no socket to go on, is asked again only
  /// after this long.
  final Duration retryAfter;
  final DateTime Function() _now;

  /// Art kept at once; the least recently used goes first.
  static const kept = 48;

  final _art = <String, DaemonIndividualArt>{};
  final _pending = <String, String>{}; // requestId -> key
  final _asked = <String, Timer>{}; // key -> the answer's deadline
  final _failedAt = <String, DateTime>{};
  int _next = 0;
  bool _disposed = false;

  static String _key(
    ZooDaemon d,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) => '${d.uid} ${d.id} ${d.seed} ${size.name} $version ${mood.name}';

  /// [daemon]'s own plate at [size], [version] and [mood], when the harness
  /// process has drawn it; otherwise null, and it is asked for once (again
  /// only after [retryAfter] when that failed). Never notifies while it is
  /// called, so a build may call it.
  DaemonIndividualArt? art(
    ZooDaemon daemon,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) {
    if (_disposed || daemon.seed == 0) return null;
    final def = roster.byId(daemon.id);
    if (def == null || !def.plate || def.traits == null) return null;
    final key = _key(daemon, size, version, mood);
    final have = _art.remove(key);
    if (have != null) {
      _art[key] = have; // most recently used last
      return have;
    }
    if (_asked.containsKey(key)) return null;
    final failed = _failedAt[key];
    if (failed != null && _now().difference(failed) < retryAfter) return null;
    _ask(key, daemon, size, version, mood);
    return null;
  }

  /// Ask ahead for what a new individual will show first: its reveal and
  /// portrait at the version it hatched, idle.
  void prefetch(ZooDaemon daemon) {
    for (final size in PlateSize.values) {
      art(daemon, size, daemon.version, DaemonMood.idle);
    }
  }

  void _ask(
    String key,
    ZooDaemon d,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) {
    final requestId = 'plate-${++_next}';
    _pending[requestId] = key;
    _asked[key] = Timer(answerWithin, () {
      _pending.remove(requestId);
      _asked.remove(key);
      _failedAt[key] = _now();
    });
    final sent = send('daemon_plate_get', {
      'requestId': requestId,
      'uid': d.uid,
      'id': d.id,
      'seed': d.seed,
      'size': size.name,
      'version': version,
      'mood': mood.name,
    });
    if (!sent) {
      _pending.remove(requestId);
      _asked.remove(key)?.cancel();
      _failedAt[key] = _now();
    }
  }

  /// A local frame from this computer's harness process. Only
  /// `daemon_plate` is heard; an answer nobody asked for is dropped.
  void receive(String type, Map<String, dynamic> payload) {
    if (_disposed || type != 'daemon_plate') return;
    final requestId = payload['requestId'];
    if (requestId is! String) return;
    final key = _pending.remove(requestId);
    if (key == null) return;
    _asked.remove(key)?.cancel();
    final art = _parse(payload, key);
    if (art == null) {
      _failedAt[key] = _now();
      return;
    }
    _failedAt.remove(key);
    _art[key] = art;
    while (_art.length > kept) {
      _art.remove(_art.keys.first);
    }
    notifyListeners();
  }

  /// Frames that all have their rows and material rows, and share one size.
  DaemonIndividualArt? _parse(Map<String, dynamic> payload, String key) {
    if (payload['error'] != null) return null;
    final parts = key.split(' ');
    if (payload['uid'] != parts[0] ||
        payload['size'] != parts[3] ||
        payload['version'] != parts[4] ||
        payload['mood'] != parts[5]) {
      return null;
    }
    final raw = payload['frames'];
    if (raw is! List || raw.isEmpty || raw.length > 8) return null;
    final rules = roster.rules.plate;
    final portrait = parts[3] == 'portrait';
    final width = portrait
        ? rules?.portraitCols ?? 28
        : rules?.revealCols ?? 56;
    final height =
        (portrait ? rules?.portraitRows ?? 12 : rules?.revealRows ?? 24) +
        (rules?.room ?? 0) * (portrait ? 1 : 2);
    final frames = <PlateFrame>[];
    for (final f in raw) {
      if (f is! Map || f['mats'] is! String) return null;
      final frame = PlateFrame.fromJson(f);
      if (frame == null ||
          frame.rows.length > height ||
          frame.rows.first.isEmpty) {
        return null;
      }
      for (var i = 0; i < frame.rows.length; i++) {
        if (frame.rows[i].length > width ||
            frame.rows[i].length != frame.rows.first.length ||
            !RegExp(r'^[\x20-\x7e]*$').hasMatch(frame.rows[i]) ||
            !RegExp(r'^[.magse p]*$').hasMatch(frame.mats[i])) {
          return null;
        }
      }
      if (frames.isNotEmpty &&
          (frame.rows.length != frames.first.rows.length ||
              frame.rows.first.length != frames.first.rows.first.length)) {
        return null;
      }
      frames.add(frame);
    }
    final ms = payload['frameMs'];
    return DaemonIndividualArt(
      frames,
      ms is int && ms >= 40 && ms <= 2000 ? ms : daemonPlates.frameMs,
    );
  }

  /// A new connection to the harness process, or another account: what was
  /// asked is forgotten, and failures may be asked again at once. Art that
  /// arrived stays: it is the same for the same species and seed.
  void reset() {
    for (final timer in _asked.values) {
      timer.cancel();
    }
    _asked.clear();
    _pending.clear();
    _failedAt.clear();
  }

  @override
  void dispose() {
    _disposed = true;
    reset();
    super.dispose();
  }
}
