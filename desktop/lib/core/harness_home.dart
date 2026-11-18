// Only `package:path`, so the web build loads it too.
import 'package:path/path.dart' as p;

/// The folder under the account's home that holds everything Harness keeps.
const harnessHomeName = '.harness';

/// What an entry holds: something the person would miss (data), or something
/// Harness can rebuild (state). Both are `~/.harness` today; the labels let a
/// later change move each kind on its own.
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
  logs('logs', HarnessRootKind.state),
  runtime('runtime', HarnessRootKind.state),
  hookRoutes('hook-routes', HarnessRootKind.state),
  s('s', HarnessRootKind.state),
  run('run', HarnessRootKind.state),
  shellRequests('shell-requests', HarnessRootKind.state),
  pty('pty', HarnessRootKind.state),
  uninstalling('uninstalling', HarnessRootKind.state),
  flasher('flasher', HarnessRootKind.state);

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

/// Harness's home folder and the paths of its entries.
final class HarnessHome {
  /// `<home>/.harness`, joined as the caller joins.
  HarnessHome.of(String home, {HarnessJoin join = p.join})
    : this.at(join(home, harnessHomeName), join: join);

  /// Both roots at [root]: a folder a caller already holds.
  const HarnessHome.at(this._root, {this._join = p.join});

  final String _root;
  final HarnessJoin _join;

  /// Every kind resolves to the one `.harness` folder until the roots split.
  String root(HarnessRootKind kind) => _root;

  String path(HarnessEntry entry) => _join(root(entry.root), entry.segment);
}
