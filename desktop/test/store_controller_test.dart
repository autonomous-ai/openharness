// What the Harness Store reads from the control plane: a rating and a page of
// reviews, read defensively off the wire; and the controller the store screen
// holds, which turns every failure into a sentence — a control plane that
// predates the store (404) most of all, since the store is whole without it.
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_models.dart';

/// The real client's store calls, answered by an envelope instead of a socket:
/// each goes through [unwrapApiResponse], so a 404 here is exactly the
/// [ApiException] a control plane without the store routes produces.
class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());

  Response<Object?> Function(String path) answer = (_) => _ok(null);
  final calls = <(String, Object?)>[];

  static Response<Object?> _ok(Object? data) => Response(
    requestOptions: RequestOptions(),
    statusCode: 200,
    data: {'success': true, 'data': data},
  );

  static Response<Object?> _status(int status, [String? message]) => Response(
    requestOptions: RequestOptions(),
    statusCode: status,
    data: {
      'success': false,
      'error': {'message': ?message},
    },
  );

  @override
  Future<Map<String, dynamic>?> storeRatings() async {
    calls.add(('ratings', null));
    return unwrapApiResponse(answer('ratings')) as Map<String, dynamic>?;
  }

  @override
  Future<Map<String, dynamic>?> storeReviews(String harnessId) async {
    calls.add(('reviews', harnessId));
    return unwrapApiResponse(answer('reviews')) as Map<String, dynamic>?;
  }

  @override
  Future<Map<String, dynamic>?> putStoreReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    calls.add((
      'put',
      {'id': harnessId, 'rating': rating, 'title': title, 'body': body},
    ));
    return unwrapApiResponse(answer('put')) as Map<String, dynamic>?;
  }

  @override
  Future<void> deleteStoreReview(String harnessId) async {
    calls.add(('delete', harnessId));
    unwrapApiResponse(answer('delete'));
  }
}

Map<String, Object?> _review({
  String id = 'r1',
  Object? rating = 4,
  Object? title,
  Object? body,
  Object? author = 'Ann Lee',
  Object? mine,
  Object? updatedAt = '2026-09-01T10:00:00.000Z',
}) => {
  'id': id,
  'harnessId': 'autonomous/marp',
  'rating': rating,
  'title': title,
  'body': body,
  'authorName': author,
  'mine': mine,
  'updatedAt': updatedAt,
};

void main() {
  group('StoreRating off the wire', () {
    test('a well-formed rating reads as sent', () {
      final rating = StoreRating.fromJson({
        'harnessId': 'autonomous/marp',
        'average': 4.25,
        'count': 4,
        'histogram': [0, 0, 1, 1, 2],
      })!;
      expect(rating.harnessId, 'autonomous/marp');
      expect(rating.average, 4.25);
      expect(rating.count, 4);
      expect(rating.histogram, [0, 0, 1, 1, 2]);
      expect(rating.isEmpty, isFalse);
    });

    test('anything that is not a rating is refused', () {
      expect(StoreRating.fromJson(null), isNull);
      expect(StoreRating.fromJson('autonomous/marp'), isNull);
      expect(StoreRating.fromJson({'count': 1}), isNull);
      expect(StoreRating.fromJson({'harnessId': '', 'count': 1}), isNull);
      expect(StoreRating.fromJson({'harnessId': 42, 'count': 1}), isNull);
      expect(
        StoreRating.fromJson({'harnessId': 'a/b', 'count': 'many'}),
        isNull,
      );
    });

    test(
      'bad numbers are clamped and a short or odd histogram is five bars',
      () {
        final wild = StoreRating.fromJson({
          'harnessId': 'a/b',
          'average': 9.5,
          'count': -3,
          'histogram': [2, 'x', -1],
        })!;
        expect(wild.average, 5.0, reason: 'no more than five stars');
        expect(wild.count, 0, reason: 'never a negative count');
        expect(wild.histogram, [2, 0, 0, 0, 0]);
        expect(wild.isEmpty, isTrue);

        final long = StoreRating.fromJson({
          'harnessId': 'a/b',
          'average': 'high',
          'count': 7.9,
          'histogram': [1, 1, 1, 1, 1, 1, 1],
        })!;
        expect(
          long.average,
          0.0,
          reason: 'an average that is not a number is none',
        );
        expect(long.count, 7);
        expect(long.histogram, [1, 1, 1, 1, 1]);

        final bare = StoreRating.fromJson({'harnessId': 'a/b', 'count': 2})!;
        expect(bare.histogram, [0, 0, 0, 0, 0]);
      },
    );

    test('the empty rating is what a page shows before anyone speaks', () {
      final none = StoreRating.none('autonomous/typst');
      expect(none.harnessId, 'autonomous/typst');
      expect(none.isEmpty, isTrue);
      expect(none.average, 0);
      expect(none.histogram, [0, 0, 0, 0, 0]);
    });
  });

  group('StoreReview off the wire', () {
    test(
      'words are trimmed, blanks are none, and the author is never blank',
      () {
        final review = StoreReview.fromJson(
          _review(
            title: '  Sharp decks ',
            body: ' The pane is the deck.  ',
            mine: true,
          ),
        )!;
        expect(review.id, 'r1');
        expect(review.harnessId, 'autonomous/marp');
        expect(review.rating, 4);
        expect(review.title, 'Sharp decks');
        expect(review.body, 'The pane is the deck.');
        expect(review.authorName, 'Ann Lee');
        expect(review.mine, isTrue);
        expect(review.updatedAt, DateTime.utc(2026, 9, 1, 10));

        final quiet = StoreReview.fromJson(
          _review(
            title: '   ',
            body: 7,
            author: '  ',
            mine: 'yes',
            updatedAt: 'last week',
          ),
        )!;
        expect(quiet.title, isNull);
        expect(quiet.body, isNull);
        expect(quiet.authorName, 'Harness user');
        expect(
          quiet.mine,
          isFalse,
          reason: 'only a literal true is the reader',
        );
        expect(quiet.updatedAt, DateTime.fromMillisecondsSinceEpoch(0));

        final undated = StoreReview.fromJson(
          _review(author: null, updatedAt: null),
        )!;
        expect(undated.authorName, 'Harness user');
        expect(undated.updatedAt, DateTime.fromMillisecondsSinceEpoch(0));
      },
    );

    test(
      'a review without an id, a harness or one to five stars is refused',
      () {
        expect(StoreReview.fromJson(null), isNull);
        expect(StoreReview.fromJson([_review()]), isNull);
        expect(StoreReview.fromJson({..._review(), 'id': 1}), isNull);
        expect(StoreReview.fromJson({..._review(), 'harnessId': null}), isNull);
        expect(StoreReview.fromJson(_review(rating: 'five')), isNull);
        expect(StoreReview.fromJson(_review(rating: 0)), isNull);
        expect(StoreReview.fromJson(_review(rating: 6)), isNull);
        expect(StoreReview.fromJson(_review(rating: 5.0))!.rating, 5);
      },
    );
  });

  group('ApiStoreApi', () {
    test('ratings keep the rows that read and drop the rest', () async {
      final api = _Api()
        ..answer = (_) => _Api._ok({
          'ratings': [
            {'harnessId': 'autonomous/marp', 'average': 4.5, 'count': 2},
            'junk',
            {'harnessId': '', 'count': 1},
          ],
        });
      final ratings = await ApiStoreApi(api).ratings();
      expect(ratings.map((r) => r.harnessId), ['autonomous/marp']);

      api.answer = (_) => _Api._ok({'ratings': 'none'});
      expect(await ApiStoreApi(api).ratings(), isEmpty);
      api.answer = (_) => _Api._ok(null);
      expect(await ApiStoreApi(api).ratings(), isEmpty);
    });

    test(
      'a page of reviews has its rating, its reviews and the reader\'s own',
      () async {
        final api = _Api()
          ..answer = (_) => _Api._ok({
            'rating': {
              'harnessId': 'autonomous/marp',
              'average': 4,
              'count': 1,
            },
            'reviews': [_review(mine: true), 'junk'],
            'mine': _review(mine: true),
          });
        final page = await ApiStoreApi(api).reviews('autonomous/marp');
        expect(api.calls.single, ('reviews', 'autonomous/marp'));
        expect(page.rating.count, 1);
        expect(page.reviews.map((r) => r.id), ['r1']);
        expect(page.mine?.mine, isTrue);

        api.answer = (_) => _Api._ok({'reviews': null, 'rating': 'x'});
        final empty = await ApiStoreApi(api).reviews('autonomous/typst');
        expect(empty.reviews, isEmpty);
        expect(empty.mine, isNull);
        expect(empty.rating.harnessId, 'autonomous/typst');
        expect(empty.rating.isEmpty, isTrue);
      },
    );

    test(
      'a posted review is read back, and an answer without one is an error',
      () async {
        final api = _Api()
          ..answer = (_) =>
              _Api._ok({'review': _review(title: 'Sharp', mine: true)});
        final posted = await ApiStoreApi(
          api,
        ).putReview('autonomous/marp', rating: 4, title: 'Sharp', body: 'Yes');
        expect(posted.title, 'Sharp');
        expect(api.calls.single.$1, 'put');
        expect(api.calls.single.$2, {
          'id': 'autonomous/marp',
          'rating': 4,
          'title': 'Sharp',
          'body': 'Yes',
        });

        api.answer = (_) => _Api._ok({'review': 'x'});
        await expectLater(
          ApiStoreApi(api).putReview('autonomous/marp', rating: 4),
          throwsFormatException,
        );
      },
    );

    test('delete reaches the client for that harness', () async {
      final api = _Api();
      await ApiStoreApi(api).deleteReview('autonomous/marp');
      expect(api.calls.single, ('delete', 'autonomous/marp'));
    });
  });

  group('StoreController', () {
    test('keys: a harness by its id, an engine under engine/', () {
      expect(
        StoreController.keyFor(
          const DshEntry(id: 'autonomous/marp', name: 'Marp', engine: 'claude'),
        ),
        'autonomous/marp',
      );
      expect(
        StoreController.keyFor(
          const DshEntry(
            id: 'codex',
            name: 'Codex',
            engine: 'codex',
            kind: 'engine',
          ),
        ),
        'engine/codex',
      );
    });

    test(
      'ratings load once at a time, and a harness with none reads empty',
      () async {
        final api = _Api()
          ..answer = (_) => _Api._ok({
            'ratings': [
              {'harnessId': 'autonomous/marp', 'average': 4.5, 'count': 2},
            ],
          });
        final store = StoreController(ApiStoreApi(api));
        addTearDown(store.dispose);
        var notified = 0;
        store.addListener(() => notified++);
        final first = store.loadRatings();
        expect(store.ratingsLoading, isTrue);
        await store.loadRatings();
        await first;
        expect(
          api.calls,
          hasLength(1),
          reason: 'a second load while one runs is the same load',
        );
        expect(store.ratingsLoading, isFalse);
        expect(store.ratingsLoaded, isTrue);
        expect(store.ratingsError, isNull);
        expect(store.ratingOf('autonomous/marp').average, 4.5);
        expect(store.ratingOf('autonomous/typst').isEmpty, isTrue);
        expect(notified, 2);
      },
    );

    test('a control plane without the store (404) says so, and the store keeps going', () async {
      final api = _Api()..answer = (_) => _Api._status(404, 'Not Found');
      final store = StoreController(ApiStoreApi(api));
      addTearDown(store.dispose);
      await store.loadRatings();
      expect(
        store.ratingsError,
        'Ratings and reviews are not on the Harness server yet; they arrive with its next release.',
      );
      expect(store.ratingsLoaded, isTrue);
      expect(store.ratings, isEmpty);
      expect(store.ratingOf('autonomous/marp').isEmpty, isTrue);

      await store.loadReviews('autonomous/marp');
      expect(
        store.reviewsError['autonomous/marp'],
        startsWith('Ratings and reviews are not on the Harness server yet'),
      );
      expect(store.reviews, isEmpty);
    });

    test('every other failure is a sentence too', () async {
      Future<String?> errorFor(Response<Object?> answer) async {
        final store = StoreController(
          ApiStoreApi(_Api()..answer = (_) => answer),
        );
        addTearDown(store.dispose);
        await store.loadRatings();
        return store.ratingsError;
      }

      expect(
        await errorFor(_Api._status(401)),
        'Sign in to see ratings and reviews.',
      );
      expect(
        await errorFor(_Api._status(403)),
        'Sign in to see ratings and reviews.',
      );
      expect(
        await errorFor(_Api._status(500, ' Database is down ')),
        'Database is down',
      );
      expect(
        await errorFor(_Api._status(502)),
        'Request failed (502)',
        reason: 'no server message: the envelope\'s own',
      );
      expect(
        await errorFor(_Api._status(500, '   ')),
        'Ratings are not available right now',
        reason: 'a blank server message is no sentence',
      );

      final transport = StoreController(_Throwing(StateError('socket closed')));
      addTearDown(transport.dispose);
      await transport.loadRatings();
      expect(transport.ratingsError, 'Ratings are not available right now');
      await transport.loadReviews('autonomous/marp');
      expect(
        transport.reviewsError['autonomous/marp'],
        'Reviews are not available right now',
      );
      expect(
        await transport.submit('autonomous/marp', rating: 5),
        'Your review could not be posted',
      );
      expect(
        await transport.remove('autonomous/marp'),
        'Your review could not be removed',
      );
    });

    test('a page of reviews replaces the row\'s rating, and a later success clears its error', () async {
      final api = _Api()..answer = (_) => _Api._status(503, 'Try later');
      final store = StoreController(ApiStoreApi(api));
      addTearDown(store.dispose);
      await store.loadReviews('autonomous/marp');
      expect(store.reviewsError['autonomous/marp'], 'Try later');

      api.answer = (_) => _Api._ok({
        'rating': {'harnessId': 'autonomous/marp', 'average': 3, 'count': 1},
        'reviews': [_review()],
      });
      final first = store.loadReviews('autonomous/marp');
      expect(store.reviewsLoading, contains('autonomous/marp'));
      await store.loadReviews('autonomous/marp');
      await first;
      expect(
        api.calls.where((c) => c.$1 == 'reviews'),
        hasLength(2),
        reason: 'a page already loading is not asked twice',
      );
      expect(store.reviewsError, isEmpty);
      expect(store.reviewsLoading, isEmpty);
      expect(store.reviews['autonomous/marp']!.reviews.single.id, 'r1');
      expect(store.ratingOf('autonomous/marp').average, 3);
    });

    test('submit and remove write, then read the page again', () async {
      final api = _Api();
      api.answer = (path) => switch (path) {
        'put' => _Api._ok({'review': _review(mine: true)}),
        'delete' => _Api._ok(null),
        _ => _Api._ok({'reviews': <Object>[]}),
      };
      final store = StoreController(ApiStoreApi(api));
      addTearDown(store.dispose);
      expect(
        await store.submit('autonomous/marp', rating: 4, title: 'T', body: 'B'),
        isNull,
      );
      expect(await store.remove('autonomous/marp'), isNull);
      expect(api.calls.map((c) => c.$1), [
        'put',
        'reviews',
        'delete',
        'reviews',
      ]);

      api.answer = (_) => _Api._status(401);
      expect(
        await store.submit('autonomous/marp', rating: 4),
        'Sign in to see ratings and reviews.',
      );
      expect(
        await store.remove('autonomous/marp'),
        'Sign in to see ratings and reviews.',
      );
    });
  });
}

class _Throwing implements StoreApi {
  _Throwing(this.error);
  final Object error;
  @override
  Future<List<StoreRating>> ratings() async => throw error;
  @override
  Future<StoreReviews> reviews(String harnessId) async => throw error;
  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async => throw error;
  @override
  Future<void> deleteReview(String harnessId) async => throw error;
}
