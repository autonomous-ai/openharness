/// A daemon's evidence of work, separate from terminal connectivity. Repeated
/// packets and snapshots carry the same revision and cannot renew the lease.
class AgentActivity {
  const AgentActivity(this.state, this.epoch, this.revision, this.validForMs);
  final String state;
  final String epoch;
  final int revision;
  final int validForMs;

  static AgentActivity? fromJson(Object? value) {
    if (value is! Map) return null;
    final state = value['state'];
    final epoch = value['epoch'];
    final revision = value['revision'];
    final lease = value['validForMs'];
    if (!const ['working', 'idle', 'unknown'].contains(state) ||
        epoch is! String ||
        epoch.isEmpty ||
        revision is! int ||
        revision < 0 ||
        lease is! num ||
        !lease.isFinite ||
        lease < 0) {
      return null;
    }
    return AgentActivity(
      state as String,
      epoch,
      revision,
      lease.clamp(0, 30000).toInt(),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AgentActivity &&
      state == other.state &&
      epoch == other.epoch &&
      revision == other.revision;
  @override
  int get hashCode => Object.hash(state, epoch, revision);
}

class AgentActivityOrder {
  AgentActivity? latest;
  final _retired = <String>{};
  bool isOlder(AgentActivity next) =>
      _retired.contains(next.epoch) ||
      (latest?.epoch == next.epoch && next.revision < latest!.revision);
  bool accept(AgentActivity next) {
    final prior = latest;
    if (_retired.contains(next.epoch)) return false;
    if (prior != null) {
      if (next.epoch == prior.epoch && next.revision <= prior.revision) {
        return false;
      }
      if (next.epoch != prior.epoch) _retired.add(prior.epoch);
    }
    latest = next;
    return true;
  }
}
