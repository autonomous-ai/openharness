/// What a host keeps of the account on this device, beside the Super Tab
/// views the Swarm client keeps, so it can draw it at once: the web keeps the
/// account's computers (`web/onboarding/saved_computers.dart`). Each adds how
/// to clear its copy, and Settings ▸ Account's Clear now clears them with the
/// views. Desktop adds none.
class BrowserCopies {
  final _clears = <Future<void> Function()>[];

  void add(Future<void> Function() clear) => _clears.add(clear);

  /// Every copy; fails as the first that fails does, after trying them all.
  Future<void> clear() async {
    await Future.wait([for (final clear in _clears) clear()]);
  }
}
