import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import 'controller.dart';

/// One project's last four weeks as the server counts them (backend read/projectActivity.ts, task #4662): its tasks
/// shipped each day, oldest first, and when anything in it last moved.
class SuperTabProjectActivity {
  SuperTabProjectActivity.fromJson(Map<String, dynamic> row)
    : shipped = List.unmodifiable([
        for (final day in row['shipped'] as List? ?? const [])
          (day as num).toInt(),
      ]),
      updatedAt = switch (row['updatedAt']) {
        final num at => DateTime.fromMillisecondsSinceEpoch(at.toInt()),
        _ => null,
      };

  final List<int> shipped;
  final DateTime? updatedAt;

  int get total => shipped.fold(0, (sum, day) => sum + day);
}

/// Reads every readable project's activity when the Projects page shows and again when its projects change: the
/// counts move only when a task ships, so nothing polls. A server before the read answers 404, and the page draws its
/// rows without it.
class SuperTabProjectActivityReader extends ChangeNotifier {
  SuperTabProjectActivityReader({required this.tabId, required this.request});

  final String tabId;
  final SuperTabRequest request;

  /// By project id; empty until the first answer, and when the server has no such read.
  Map<String, SuperTabProjectActivity> byProject = const {};
  int _read = 0;
  bool _disposed = false;

  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_read;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/project-activity',
      );
      if (read != _read || _disposed) return;
      byProject = Map.unmodifiable({
        for (final row in answer['projects'] as List? ?? const [])
          if (row is Map && row['projectId'] is String)
            row['projectId'] as String: SuperTabProjectActivity.fromJson(
              row.cast<String, dynamic>(),
            ),
      });
      notifyListeners();
    } on SuperTabFailure catch (failure) {
      // An older server has no such read: the rows are whole without it.
      if (failure.statusCode != 404) {
        appLog.warn(
          'super-tabs',
          'project activity read failed (${failure.code})',
        );
      }
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'project activity read failed (${error.runtimeType})',
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
