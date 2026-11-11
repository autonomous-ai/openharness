/// The Node the local daemon runs on, as `/api/status.node` reports it, and why it is not on Node 24.
/// The copy matches `harness status`.
class DaemonNode {
  const DaemonNode(this.version, [this.migration]);

  final String version;

  /// The reason the daemon stays on an older Node; null when nothing holds it back.
  final String? migration;

  static const _why = {
    'no-manifest-entry': 'no Node 24 for this computer yet',
    'manifest-unreachable': 'could not reach the update server',
    'download-failed': 'the download failed',
    'does-not-run': 'Node 24 did not start here',
    'unmanaged':
        'this Harness runs on a Node it does not manage; install Node 24',
    'rolled-back': 'Node 24 did not come up; back on 22',
    'cannot-switch': 'this Harness cannot switch Node here yet',
  };

  /// Null from a daemon too old to send `node`: nothing is shown for it.
  static DaemonNode? fromStatus(Object? node) {
    if (node is! Map || node['version'] is! String) return null;
    final migration = node['migration'];
    return DaemonNode(
      node['version'] as String,
      migration is String && _why.containsKey(migration) ? migration : null,
    );
  }

  String get line {
    final why = _why[migration];
    if (why == null) return 'Node $version';
    final major = version.replaceFirst('v', '').split('.').first;
    return 'Node $version · stays on $major: $why';
  }
}
