import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

/// The dial on this desk, as the daemon last reported it over the local socket.
///
/// Three facts and nothing else: whether it is plugged in, which firmware it greeted with, and whether
/// an update is going over the cable right now. The daemon sends `dial_status` on every change and
/// once more the moment this window connects, so a window opened after the dial was plugged in is not
/// left believing there is none.
/// Everything a device persists, and the face it persists it on.
///
/// Named fields, not the firmware's NVS bitmask: those bit positions are the device's private
/// arrangement, and an app that knew them would have to ship in step with a header it cannot see.
///
/// [round] is not a preference. It is the face, and the row it governs is HIDDEN on a square rather
/// than greyed out — a disabled control still claims the setting exists.
class DeviceSettings {
  const DeviceSettings({
    required this.brightness,
    required this.character,
    required this.face,
    required this.muted,
    required this.quiet,
    required this.straightTitle,
    required this.focusFace,
    required this.scrollReversed,
    required this.round,
    required this.voiceLang,
    this.followCompanion,
    this.companion,
    this.companionProtocol,
    this.companionDetails,
  });

  final int brightness;
  final int character;

  /// The glass, in pixels across. Informational — a support line reads it, nobody chooses it.
  final int face;
  final bool muted, quiet, straightTitle, focusFace, scrollReversed, round;
  final String voiceLang;
  final bool? followCompanion;
  final String? companion;
  final int? companionProtocol;
  final DialCompanion? companionDetails;

  /// Last-reported values for the local device library. Restoring these never
  /// marks a device connected or sends settings back to it.
  Map<String, Object?> toJson() => {
    'brightness': brightness,
    'character': character,
    'face': face,
    'muted': muted,
    'quiet': quiet,
    'straightTitle': straightTitle,
    'focusFace': focusFace,
    'scrollReversed': scrollReversed,
    'round': round,
    'voiceLang': voiceLang,
    if (followCompanion != null) 'followCompanion': followCompanion,
  };

  /// Read with `is`, never `as`, and refused whole when a field is missing: a default here is a value
  /// this window invented, and the pane would then offer a setting the device does not have.
  static DeviceSettings? fromJson(Object? value) {
    if (value is! Map) return null;
    bool? flag(String key) => value[key] is bool ? value[key] as bool : null;
    final brightness = value['brightness'];
    final character = value['character'];
    final face = value['face'];
    final lang = value['voiceLang'];
    if (brightness is! num ||
        character is! num ||
        face is! num ||
        lang is! String) {
      return null;
    }
    final muted = flag('muted'), quiet = flag('quiet');
    final straight = flag('straightTitle'), focus = flag('focusFace');
    final scroll = flag('scrollReversed'), round = flag('round');
    if (muted == null ||
        quiet == null ||
        straight == null ||
        focus == null ||
        scroll == null ||
        round == null) {
      return null;
    }
    return DeviceSettings(
      brightness: brightness.round().clamp(0, 100),
      character: character.round(),
      face: face.round(),
      muted: muted,
      quiet: quiet,
      straightTitle: straight,
      focusFace: focus,
      scrollReversed: scroll,
      round: round,
      voiceLang: lang,
      followCompanion: value['followCompanion'] is bool
          ? value['followCompanion'] as bool
          : null,
      companion: value['companion'] is String
          ? value['companion'] as String
          : null,
      companionProtocol: value['companionProtocol'] == 2 ? 2 : null,
      companionDetails: value['companionProtocol'] == 2
          ? DialCompanion.fromJson(value['companionDetails'])
          : null,
    );
  }
}

/// The identity acknowledged by the physical screen, not an optimistic choice.
class DialCompanion {
  const DialCompanion({
    required this.id,
    required this.uid,
    required this.version,
    required this.seed,
    required this.colour,
    required this.mark,
  });

  final String id, uid, version;
  final int seed, colour, mark;

  static DialCompanion? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'], uid = value['uid'], version = value['version'];
    final seed = value['seed'], colour = value['colour'], mark = value['mark'];
    if (id is! String ||
        uid is! String ||
        uid.isEmpty ||
        uid.length > 64 ||
        !const ['0.1', '1.0', '2.0'].contains(version) ||
        seed is! int ||
        seed < 0 ||
        seed > 0xffffffff ||
        colour is! int ||
        colour < -1 ||
        colour > 5 ||
        mark is! int ||
        mark < 0 ||
        mark > 4) {
      return null;
    }
    return DialCompanion(
      id: id,
      uid: uid,
      version: version as String,
      seed: seed,
      colour: colour,
      mark: mark,
    );
  }
}

class DialStatus {
  const DialStatus({
    required this.attached,
    this.id,
    this.mac,
    this.settings,
    this.devices = const [],
    this.fw,
    this.hw,
    this.updating,
  });

  static const none = DialStatus(attached: false);

  final bool attached;

  /// Which device this is when the desk holds more than one — the daemon fleet's key, the USB serial.
  /// Null from a daemon that predates per-device addressing.
  final String? id;

  /// The device's own address. Survives being moved to another port; [id] may not.
  final String? mac;

  /// What the device last said it holds — never what this window last asked for. Null until it has
  /// greeted, and from a firmware that has no settings to report.
  final DeviceSettings? settings;

  /// Every device on this desk. Empty from a daemon that reports only one; the flat fields on this
  /// object then repeat whichever it picked.
  final List<DialStatus> devices;

  /// The version it greeted with. Null until the first greeting — a dial can be on the wire before it
  /// has said which image it runs.
  final String? fw;

  /// Which of the two dials it is — `cst9217+axp2101` or `cst816s` — as the firmware detected itself
  /// at boot. Null from a firmware that predates the field. Shown only in the row's detail: a person
  /// does not choose it, support reads it.
  final String? hw;

  /// The version on its way over the cable, or null. The one state that deserves its own word in the
  /// window, because it is the minute in which people unplug the thing.
  final String? updating;

  /// What to call this robot on screen.
  ///
  /// `hw` is what the firmware detected itself as at boot — `cst816s`, `cst9217+axp2101` — which is a
  /// touch controller, not a name a person would use. It is shown in the card's detail line where
  /// support can read it; the heading gets a word instead, and "Dial" is the only device this
  /// firmware is.
  String get name => 'Dial';

  /// Read with `is`, never `as`: this crosses a socket, so its shape belongs to the other end.
  static DialStatus fromJson(Map<String, dynamic> json) => DialStatus(
    attached: json['attached'] == true,
    id: json['id'] is String && (json['id'] as String).isNotEmpty
        ? json['id'] as String
        : null,
    mac: json['mac'] is String && (json['mac'] as String).isNotEmpty
        ? json['mac'] as String
        : null,
    settings: DeviceSettings.fromJson(json['settings']),
    devices: [
      if (json['devices'] is List)
        for (final row in json['devices'] as List)
          if (row is Map) DialStatus.fromJson(row.cast<String, dynamic>()),
    ],
    fw: json['fw'] is String && (json['fw'] as String).isNotEmpty
        ? json['fw'] as String
        : null,
    hw: json['hw'] is String && (json['hw'] as String).isNotEmpty
        ? json['hw'] as String
        : null,
    updating:
        json['updating'] is String && (json['updating'] as String).isNotEmpty
        ? json['updating'] as String
        : null,
  );
}

/// What the rail's device row needs: the live status, plus one remembered bit — has a dial EVER been
/// seen on this computer?
///
/// That bit is what separates "no device" from "unplugged". A person who has never owned one is
/// shown the way to get one; a person whose dial is in a drawer is told it is unplugged, and is not
/// sold a second one every time they look at the rail. It persists, because the drawer outlives the
/// app's process.
class DialState extends ChangeNotifier {
  DialState([this._storage]);

  static const _seenKey = 'dial_seen';

  final LocalKeyValueStore? _storage;

  DialStatus status = DialStatus.none;
  bool seen = false;

  Future<void> restore() async {
    try {
      seen = (await _storage?.read(_seenKey)) == '1';
    } catch (_) {
      seen =
          false; // a missing or unreadable file is a first run, not a failure
    }
    notifyListeners();
  }

  /// Every device on this desk, in the order the daemon found them.
  ///
  /// A daemon that reports only one sends no list, so the flat status stands in for it. The rule is the
  /// same either way: a device that is unplugged but was seen stays on the list, because the pane shows
  /// its rows read-only rather than dropping the robot while a cable is out.
  List<DialStatus> get devices {
    if (status.devices.isNotEmpty) return status.devices;
    return status.attached || status.settings != null ? [status] : const [];
  }

  void apply(DialStatus next) {
    status = next;
    if (next.attached && !seen) {
      seen = true;
      // Never awaited: a write that fails costs one wrong word in the rail on the next launch, which
      // is a far smaller wrong than an exception thrown out of a socket frame.
      _storage?.write(_seenKey, '1').catchError((_) {});
    }
    notifyListeners();
  }

  /// A lost host connection cannot leave USB controls writable. Retain the
  /// last readings until the daemon greets this window again.
  void disconnect() {
    if (!status.attached && !devices.any((d) => d.attached)) return;
    apply(
      DialStatus(
        attached: false,
        devices: [
          for (final device in devices)
            DialStatus(
              attached: false,
              id: device.id,
              mac: device.mac,
              fw: device.fw,
              hw: device.hw,
              settings: device.settings,
            ),
        ],
      ),
    );
  }
}
