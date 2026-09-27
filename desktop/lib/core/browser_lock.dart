import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// One writer across all tabs on this origin. The browser releases the lock
/// when the callback settles or its tab closes; no expiring lease to race.
Future<T> withBrowserLock<T>(String name, Future<T> Function() action) async {
  final zone = Zone.current;
  late T result;
  Object? failure;
  StackTrace? trace;
  await web.window.navigator.locks
      .request(
        'harness.web.v1.$name',
        ((web.Lock _) => zone.run(() async {
          try {
            result = await action();
          } catch (error, stack) {
            failure = error;
            trace = stack;
          }
        }).toJS).toJS,
      )
      .toDart;
  if (failure != null) Error.throwWithStackTrace(failure!, trace!);
  return result;
}
