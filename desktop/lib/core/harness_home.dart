// Only `package:path` and the look, whose `dart:io` side the web build swaps
// for a stub, so the web build loads it too.
import 'package:path/path.dart' as p;

import 'harness_home_look_stub.dart'
    if (dart.library.io) 'harness_home_look_io.dart';

export 'harness_home_look_stub.dart'
    if (dart.library.io) 'harness_home_look_io.dart';

/// The folder under the account's home that holds everything Harness keeps.
const harnessHomeName = '.harness';

/// What an entry holds: something the person would miss (data), or something
/// Harness can rebuild (state). On Linux each kind has its XDG root; elsewhere,
/// and on a Linux home not moved yet, both are `~/.harness`.
enum HarnessRootKind { data, state }

/// Every name Harness uses directly under its home folder, with its kind.
enum HarnessEntry {
  auth('auth', HarnessRootKind.data),
  computerId('computer-id', HarnessRootKind.data),
  cli('cli', HarnessRootKind.data),
  connections('connections', HarnessRootKind.data),
  agentMessages('agent-messages', HarnessRootKind.data),
  bin('bin', HarnessRootKind.data),
  dsh('dsh', HarnessRootKind.data),
  claudeProfiles('claude-profiles', HarnessRootKind.data),
  desktopApp('desktop-app-v2', HarnessRootKind.data),
  viewerApp('viewer-app-v2', HarnessRootKind.data),
  tui('tui', HarnessRootKind.data),
  devices('devices', HarnessRootKind.data),
  lessons('lessons', HarnessRootKind.data),
  gridFleet('grid-fleet', HarnessRootKind.data),
  community('community', HarnessRootKind.data),
  memory('memory', HarnessRootKind.data),
  logs('logs', HarnessRootKind.state),
  runtime('runtime', HarnessRootKind.state),
  hookRoutes('hook-routes', HarnessRootKind.state),
  s('s', HarnessRootKind.state),
  run('run', HarnessRootKind.state),
  shellRequests('shell-requests', HarnessRootKind.state),
  pty('pty', HarnessRootKind.state),
  uninstalling('uninstalling', HarnessRootKind.state),
  flasher('flasher', HarnessRootKind.state),
  monitor('monitor', HarnessRootKind.state);

  const HarnessEntry(this.segment, this.root);

  final String segment;
  final HarnessRootKind root;
}

/// Joins two path parts. Each caller passes the join it used before, so every
/// path it builds stays byte for byte the same.
typedef HarnessJoin = String Function(String left, String right);

/// `left` + [separator] + `right`, nothing normalized: the string joins.
HarnessJoin separatorJoin(String separator) =>
    (left, right) => '$left$separator$right';

/// What the rule reads of this computer: whether it is Linux, its environment
/// (the XDG variables) and one existence check.
final class HomeLook {
  const HomeLook({
    required this.linux,
    required this.environment,
    required this.exists,
  });

  final bool linux;
  final Map<String, String> environment;
  final bool Function(String path) exists;

  /// This look, each folder answered as it first was: roots found through it
  /// twice come from one layout even while Harness's folder moves.
  HomeLook remembered() {
    final seen = <String, bool>{};
    return HomeLook(
      linux: linux,
      environment: environment,
      exists: (path) => seen[path] ??= exists(path),
    );
  }
}

/// Harness's roots and the paths of its entries.
final class HarnessHome {
  /// The roots for [home] by the rule (docs/plans/2026-11-18-linux-xdg-paths-design.md):
  /// on Linux the XDG roots when the data root exists, else `<home>/.harness`
  /// when that exists, else the XDG roots. Off Linux, `<home>/.harness`.
  /// Resolved here, once: a caller that must follow a move builds it again.
  factory HarnessHome.of(
    String home, {
    HarnessJoin join = p.join,
    HomeLook? look,
  }) {
    final legacy = join(home, harnessHomeName);
    final rule = look ?? platformHomeLook();
    if (!rule.linux) return HarnessHome._(legacy, legacy, legacy, join);
    final data = join(
      _xdgBase(rule, 'XDG_DATA_HOME', home, 'share', join),
      'harness',
    );
    final state = join(
      _xdgBase(rule, 'XDG_STATE_HOME', home, 'state', join),
      'harness',
    );
    // The data root is the one switch, so the bridge or a ~/.harness that
    // something old recreates never sends a moved home back.
    if (!rule.exists(data) && rule.exists(legacy)) {
      return HarnessHome._(legacy, legacy, legacy, join);
    }
    return HarnessHome._(data, state, legacy, join);
  }

  /// Both roots at [root]: a folder a caller already holds.
  const HarnessHome.at(String root, {HarnessJoin join = p.join})
    : this._(root, root, root, join);

  /// Two roots a caller already holds. No older folder is known, so
  /// [legacyPath] names the data root's entry.
  const HarnessHome.roots({
    required String data,
    required String state,
    HarnessJoin join = p.join,
  }) : this._(data, state, data, join);

  const HarnessHome._(this._data, this._state, this._legacy, this._join);

  final String _data;
  final String _state;
  final String _legacy;
  final HarnessJoin _join;

  String root(HarnessRootKind kind) => switch (kind) {
    HarnessRootKind.data => _data,
    HarnessRootKind.state => _state,
  };

  String path(HarnessEntry entry) => _join(root(entry.root), entry.segment);

  /// `<home>/.harness/<entry>`, whatever the rule says: where Harness kept
  /// everything before the move.
  String legacyPath(HarnessEntry entry) => _join(_legacy, entry.segment);
}

/// The variable when it is an absolute path, else `<home>/.local/<fallback>`.
/// Its trailing slashes go, as the CLI's `posix.join` drops them, so a string
/// join names the folder the CLI uses, byte for byte.
String _xdgBase(
  HomeLook look,
  String variable,
  String home,
  String fallback,
  HarnessJoin join,
) {
  final value = look.environment[variable];
  if (value != null && p.posix.isAbsolute(value)) {
    return value.replaceFirst(RegExp(r'/+$'), '');
  }
  return join(join(home, '.local'), fallback);
}
