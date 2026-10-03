import 'process_responsibility.dart' show ResponsibilityProbe;

/// A browser has no processes to ask about: every lookup is "cannot tell",
/// which keeps the daemon.
class MacResponsibilityProbe implements ResponsibilityProbe {
  MacResponsibilityProbe();

  @override
  int? responsiblePid(int pid) => null;

  @override
  String? executablePath(int pid) => null;
}
