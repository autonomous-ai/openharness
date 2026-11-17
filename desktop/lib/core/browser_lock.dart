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

/// The same lock for an [action] with nothing to await, such as a few reads and writes of local storage. It returns
/// no promise to the browser, so the lock is released when [action] returns, and its future is made in the root zone.
///
/// A widget test's fake-async zone stops running its microtasks when the test ends. [withBrowserLock] made there left
/// the lock held and the future it returned pending for good, and the shared store kept that future as its
/// migration: every later test on the page waited on it (task #3728, which stopped the web test runner).
Future<T> withBrowserLockSync<T>(String name, T Function() action) {
  final caller = Zone.current;
  return Zone.root.run(() async {
    late T result;
    Object? failure;
    StackTrace? trace;
    await web.window.navigator.locks
        .request(
          'harness.web.v1.$name',
          ((web.Lock _) {
            try {
              result = caller.run(action);
            } catch (error, stack) {
              failure = error;
              trace = stack;
            }
          }).toJS,
        )
        .toDart;
    if (failure != null) Error.throwWithStackTrace(failure!, trace!);
    return result;
  });
}
