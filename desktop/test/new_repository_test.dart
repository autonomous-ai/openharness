import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/new_repository.dart';

/// A project row as the backend sends it, with [creation] as its
/// `repositoryCreation` (backend projects.ts, task #1788).
Map<String, dynamic> _row([Object? creation]) => {
  'id': 'p1',
  'name': 'Notes',
  'ownerId': 'owner',
  'leadConversationId': 'p1-chat',
  'repositoryCreation': ?creation,
};

void main() {
  group('a project\'s new repository (task #3374)', () {
    test('is read with each field the backend writes', () {
      final creation = SuperTabProject.fromJson(
        _row({
          'owner': 'acme',
          'name': 'notes',
          'private': true,
          'by': 'owner',
          'at': 1793886612889,
          'state': 'created',
          'repositoryUrl': 'https://github.com/acme/notes',
          'reachable': false,
        }),
      ).repositoryCreation!;
      expect(creation.owner, 'acme');
      expect(creation.name, 'notes');
      expect(creation.private, isTrue);
      expect(creation.at, 1793886612889);
      expect(creation.state, 'created');
      expect(creation.repositoryUrl, 'https://github.com/acme/notes');
      expect(creation.reachable, isFalse);
      expect(creation.reason, isNull);

      final refused = SuperTabProject.fromJson(
        _row({
          'owner': 'acme',
          'name': 'notes',
          'private': false,
          'by': 'owner',
          'at': 5,
          'state': 'refused',
          'reason': 'Repository creation failed.',
        }),
      ).repositoryCreation!;
      expect(refused.private, isFalse);
      expect(refused.reason, 'Repository creation failed.');
      expect(refused.reachable, isNull);
    });

    test('is null when absent or malformed, as from an older backend', () {
      expect(SuperTabProject.fromJson(_row()).repositoryCreation, isNull);
      for (final bad in [
        'created',
        <String, dynamic>{'owner': 'acme', 'name': 'notes', 'state': 'waiting'},
        <String, dynamic>{'owner': 'acme', 'at': 1, 'state': 'waiting'},
        <String, dynamic>{'name': 'notes', 'at': 1, 'state': 'waiting'},
        <String, dynamic>{'owner': 'acme', 'name': 'notes', 'at': 1},
      ]) {
        expect(
          SuperTabProject.fromJson(_row(bad)).repositoryCreation,
          isNull,
          reason: '$bad',
        );
      }
    });
  });

  group('a new repository\'s name (F1)', () {
    test('takes GitHub\'s characters, up to 100, never . or ..', () {
      for (final good in [
        'notes',
        'notes-app',
        'Notes_2',
        'a.b',
        '...',
        'x' * 100,
      ]) {
        expect(newRepositoryNameProblem(good), isNull, reason: good);
      }
      for (final bad in ['notes app', 'notes/app', 'é', '.', '..', 'x' * 101]) {
        expect(
          newRepositoryNameProblem(bad),
          'Use letters, numbers, - _ or . (up to 100).',
          reason: bad,
        );
      }
      // Nothing typed yet is no fault to show, but no name either.
      expect(newRepositoryNameProblem(''), isNull);
      expect(newRepositoryNameUsable(''), isFalse);
      expect(newRepositoryNameUsable('notes'), isTrue);
      expect(newRepositoryNameUsable('notes app'), isFalse);
    });
  });

  test('its owners are the Swarm\'s GitHub organizations, in the Swarm\'s order, each once', () {
    Map<String, dynamic> project(String id, String? url) => {
      ..._row(),
      'id': id,
      'repository': ?(url == null ? null : {'repositoryUrl': url}),
    };
    final snapshot = SuperTabSnapshot.fromJson({
      'id': 'tab',
      'projects': [
        project('a', 'https://github.com/autonomous-ai/openharness'),
        project('b', null),
        project('c', 'https://gitlab.com/acme/site'),
        project('d', 'https://github.com/Acme/notes.git'),
        project('e', 'https://github.com/AUTONOMOUS-AI/website'),
        project('f', 'git@github.com:acme/api.git'),
      ],
    });
    expect(newRepositoryOwners(snapshot), ['autonomous-ai', 'Acme']);
  });

  group('what GitHub\'s sign-in made of an ask', () {
    const ask = NewRepositoryAsk(owner: 'acme', name: 'notes', private: true);
    final at = DateTime.utc(2026, 11, 5, 12).millisecondsSinceEpoch;
    final now = DateTime.fromMillisecondsSinceEpoch(at, isUtc: true);
    SuperTabRepositoryCreation creation(
      String state, {
      int? when,
      String? url,
      bool? reachable,
      String? reason,
    }) => SuperTabRepositoryCreation(
      owner: 'acme',
      name: 'notes',
      private: true,
      at: when ?? at,
      state: state,
      repositoryUrl: url,
      reachable: reachable,
      reason: reason,
    );
    String? line(NewRepositoryOutcome outcome) =>
        outcome is NewRepositoryFailed ? outcome.message : null;

    test('created gives its address and whether teammates can reach it', () {
      final outcome = newRepositoryOutcome(
        creation(
          'created',
          url: 'https://github.com/acme/notes',
          reachable: false,
        ),
        ask,
        at: at,
        now: now,
      );
      expect(outcome, isA<NewRepositoryCreated>());
      outcome as NewRepositoryCreated;
      expect(outcome.repositoryUrl, 'https://github.com/acme/notes');
      expect(outcome.reachable, isFalse);
      expect(
        newRepositoryUnreachable(ask),
        'acme/notes is made, but Harness can\u2019t reach it yet. An owner of acme adds it under Settings \u2192 GitHub Apps \u2192 Harness \u2192 Configure.',
      );
    });

    test('each failure says its line (F2, F3, F8, F9)', () {
      expect(
        line(newRepositoryOutcome(creation('taken'), ask, at: at, now: now)),
        'acme/notes already exists. Choose another name, or choose it under GitHub in Choose repo to use it.',
      );
      expect(
        line(
          newRepositoryOutcome(
            creation('refused', reason: 'Repository creation failed.'),
            ask,
            at: at,
            now: now,
          ),
        ),
        'GitHub didn\u2019t let you create a repository in acme: Repository creation failed. Ask an owner of acme, or create it on GitHub and paste its link under GitHub in Choose repo.',
      );
      expect(
        line(
          newRepositoryOutcome(
            creation('refused', reason: 'Only owners may'),
            ask,
            at: at,
            now: now,
          ),
        ),
        startsWith(
          'GitHub didn\u2019t let you create a repository in acme: Only owners may. Ask',
        ),
      );
      expect(
        line(
          newRepositoryOutcome(creation('cancelled'), ask, at: at, now: now),
        ),
        'Nothing was created.',
      );
      expect(
        line(newRepositoryOutcome(creation('failed'), ask, at: at, now: now)),
        'GitHub didn\u2019t answer. Nothing was created.',
      );
    });

    test('waits while the ask waits or is being created, then says so when it ran out', () {
      for (final state in ['waiting', 'creating']) {
        expect(
          newRepositoryOutcome(creation(state), ask, at: at, now: now),
          isA<NewRepositoryWaiting>(),
        );
      }
      // The sign-in's link lasts 10 minutes: nobody came back from GitHub.
      expect(
        line(
          newRepositoryOutcome(
            creation('waiting'),
            ask,
            at: at,
            now: now.add(const Duration(minutes: 10, seconds: 1)),
          ),
        ),
        'Nothing was created.',
      );
      // A create that never answered (security review of #3201): Try again
      // finds the repository if it was made.
      expect(
        newRepositoryOutcome(
          creation('creating'),
          ask,
          at: at,
          now: now.add(const Duration(minutes: 4)),
        ),
        isA<NewRepositoryWaiting>(),
      );
      expect(
        line(
          newRepositoryOutcome(
            creation('creating'),
            ask,
            at: at,
            now: now.add(const Duration(minutes: 5, seconds: 1)),
          ),
        ),
        'GitHub didn\u2019t answer in time. Try again: if acme/notes was made, Harness finds it.',
      );
    });

    test('an outcome of another ask is never this one\'s', () {
      // An older ask's, or none yet: the state has not caught up.
      for (final older in [
        creation('created', when: at - 1, url: 'https://github.com/acme/old'),
        null,
      ]) {
        expect(
          newRepositoryOutcome(older, ask, at: at, now: now),
          isA<NewRepositoryWaiting>(),
        );
      }
      // A newer ask replaced this one, whose link now changes nothing.
      expect(
        line(
          newRepositoryOutcome(
            creation('waiting', when: at + 1),
            ask,
            at: at,
            now: now,
          ),
        ),
        'Nothing was created.',
      );
    });

    test('the organization\'s own steps say what its owner does (F4, F5)', () {
      expect(
        newRepositoryNotInstalled('acme'),
        'Harness isn\u2019t on acme\u2019s GitHub yet.',
      );
      expect(
        newRepositoryNotAccepted('acme'),
        'An owner of acme needs to accept Harness\u2019s new permission once: GitHub Settings \u2192 GitHub Apps \u2192 Harness.',
      );
      expect(
        newRepositoryOwnerMessage(
          'acme',
          installUrl: 'https://github.com/apps/harness/installations/new',
        ),
        'Could you install Harness on acme\u2019s GitHub, so we can create repositories there? https://github.com/apps/harness/installations/new',
      );
      expect(
        newRepositoryOwnerMessage('acme'),
        'Could you accept Harness\u2019s new permission on acme once? GitHub Settings \u2192 GitHub Apps \u2192 Harness.',
      );
    });
  });
}
