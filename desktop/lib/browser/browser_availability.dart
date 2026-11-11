/// Whether a machine can run an agent's Browser, as its daemon answers `agent_browser_available` (cli
/// services/agentBrowser/podman.ts `Availability`), plus the two answers this app gives for a daemon that could not
/// say: [unsupported] for one too old to know the request, [unavailable] for one whose service did not answer.
class BrowserAvailability {
  const BrowserAvailability(this.state, {this.ownMachine = false});

  static const ready = 'ready';
  static const stopped = 'stopped';
  static const needsSetup = 'needs_setup';
  static const podmanOld = 'podman_old';
  static const podmanMemory = 'podman_memory';
  static const unsupported = 'unsupported';
  static const unavailable = 'unavailable';

  final String state;

  /// With [needsSetup]: the person's own Podman machine will not start, so Harness sets up one of its own.
  final bool ownMachine;

  factory BrowserAvailability.fromJson(Map<String, dynamic> j) {
    final state = j['state'];
    if (state == needsSetup) {
      return BrowserAvailability(
        needsSetup,
        ownMachine: j['ownMachine'] == true,
      );
    }
    return BrowserAvailability(
      const {ready, stopped, podmanOld, podmanMemory}.contains(state)
          ? state as String
          : unavailable,
    );
  }
}

/// Browser is offered where [offersBrowser] asks for it (a Swarm agent's header), never on the web build or on
/// Windows, which v1 does not cover.
bool browserOffered({
  required bool web,
  required bool windows,
  required bool offersBrowser,
}) => offersBrowser && !web && !windows;
