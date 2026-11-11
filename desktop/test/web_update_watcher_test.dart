import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/update/web_update_watcher.dart';

/// A page that opened on one release finds out a newer one is out: it
/// re-reads the host's release manifest, and says so once it names another
/// version (task #2185).
void main() {
  WebUpdateWatcher watcher(
    String? running,
    List<String?> reads, {
    Duration every = const Duration(minutes: 5),
  }) {
    var i = 0;
    return WebUpdateWatcher(
      running: running,
      every: every,
      readLatest: () async => reads[i < reads.length ? i++ : reads.length - 1],
    );
  }

  test('a different version is ready, the same one is not', () async {
    final same = watcher('1.3.51', ['1.3.51']);
    await same.check();
    expect(same.updateReady, isFalse);
    final newer = watcher('1.3.51', ['1.3.52']);
    await newer.check();
    expect(newer.updateReady, isTrue);
    // A rollback is also another build: Reload brings the page to it.
    final rolledBack = watcher('1.3.51', ['1.3.50']);
    await rolledBack.check();
    expect(rolledBack.updateReady, isTrue);
  });

  test('an unreadable manifest changes nothing, before or after the bar '
      'shows', () async {
    final w = watcher('1.3.51', [null, '1.3.52', null]);
    await w.check();
    expect(w.updateReady, isFalse);
    await w.check();
    expect(w.updateReady, isTrue);
    await w.check();
    expect(w.updateReady, isTrue);
  });

  test('a read that throws is no answer either', () async {
    final w = WebUpdateWatcher(
      running: '1.3.51',
      readLatest: () async => throw StateError('offline'),
    );
    await w.check();
    expect(w.updateReady, isFalse);
  });

  test('a page that does not know its own version never says ready', () async {
    final w = watcher(null, ['1.3.52']);
    await w.check();
    expect(w.updateReady, isFalse);
  });

  test('listeners hear it once, however many checks follow', () async {
    final w = watcher('1.3.51', ['1.3.52']);
    var told = 0;
    w.addListener(() => told++);
    await w.check();
    await w.check();
    await w.check();
    expect(told, 1);
  });

  test('it checks again every interval until disposed', () {
    fakeAsync((async) {
      var reads = 0;
      final w = WebUpdateWatcher(
        running: '1.3.51',
        every: const Duration(minutes: 5),
        readLatest: () async {
          reads++;
          return '1.3.51';
        },
      )..start();
      expect(reads, 0);
      async.elapse(const Duration(minutes: 5));
      expect(reads, 1);
      async.elapse(const Duration(minutes: 10));
      expect(reads, 3);
      w.dispose();
      async.elapse(const Duration(minutes: 30));
      expect(reads, 3);
    });
  });
}
