import 'pending_pair.dart';

/// Native builds never open a `/pair` link: the phone app scans with its own camera, and a desktop
/// shows the QR rather than reading one.
class PendingPairStore {
  const PendingPairStore();

  PendingPair? capture(DateTime now) => null;
  void clear() {}
}
