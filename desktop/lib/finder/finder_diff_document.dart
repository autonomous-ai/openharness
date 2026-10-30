import 'package:flutter/foundation.dart';

import 'finder_files.dart' show FinderException;
import 'finder_load.dart';
import 'finder_models.dart';

/// One change open in a diff tab: the change, and its diff as Git tells it.
class FinderDiffDocument extends ChangeNotifier {
  FinderDiffDocument(this.change, this.path, this._read);

  final GitChange change;

  /// The changed file, absolute.
  final String path;
  final Future<List<DiffLine>> Function(GitChange change) _read;

  FinderLoad<List<DiffLine>> diff = const FinderLoading();
  bool _disposed = false;

  /// Reads the diff again — after a save, a stage or the disk moving. The
  /// lines on screen stay until the new ones arrive.
  Future<void> load() async {
    try {
      diff = FinderLoaded(await _read(change));
    } on FinderException catch (error) {
      diff = FinderFailed(error.message);
    }
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
