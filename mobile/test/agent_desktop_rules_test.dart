import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';

/// An agent's name, place and resumability read as the desktop's `Agent` and `AgentProject` read
/// them, so a harness says the same thing on both.
void main() {
  AgentProject project(Map<String, dynamic> wire) => AgentProject.fromJson({
    'name': 'autonomous-harness',
    'cwd': '/work/autonomous-harness',
    ...wire,
  })!;

  group('the folder is the one the person chose', () {
    test('a worktree is named by its repository', () {
      final worktree = project({
        'cwd': '/home/me/.harness/worktrees/worktree-35ab',
        'root': '/home/me/.harness/worktrees/worktree-35ab/',
      });
      expect(worktree.label, 'autonomous-harness');
    });

    test('a subfolder of a checkout is named by itself', () {
      final sub = project({
        'cwd': '/work/autonomous-harness/mobile',
        'root': '/work/autonomous-harness',
      });
      expect(sub.label, 'mobile');
    });

    test('outside Git it is the folder the daemon named', () {
      expect(project({}).label, 'autonomous-harness');
    });
  });

  group('the branch is shown only once it is one', () {
    test('a real branch is shown', () {
      expect(project({'branch': 'feature/x'}).shownBranch, 'feature/x');
    });

    test('not while Harness\'s placeholder waits for the session\'s name', () {
      final pending = project({'branch': 'harness/3', 'branchPending': true});
      expect(pending.shownBranch, isNull);
      expect(pending.branchLabel, 'harness/3');
      expect(pending.branchDetail, 'Branch: harness/3');
    });

    test('not on a commit', () {
      final detached = project({'branch': 'Detached 65281563'});
      expect(detached.shownBranch, isNull);
      expect(detached.branchDetail, 'No branch: on commit 65281563');
    });
  });

  group('whether stopped work comes back is its machine\'s to say', () {
    Agent agent(Map<String, dynamic> wire) =>
        Agent.fromJson({'id': 'a', 'name': 'a', 'status': 'stopped', ...wire});

    test('a reported resume mode is enough, for any engine', () {
      final devin = agent({'engine': 'devin', 'resumeMode': 'fresh'});
      expect(devin.canPauseAndResume, isTrue);
      expect(devin.resumesFreshConversation, isTrue);
    });

    test('a conversation engine with nothing recorded opens a new one', () {
      final blank = agent({'engine': 'claude', 'resumeMode': 'conversation'});
      expect(blank.canPauseAndResume, isTrue);
      expect(blank.resumesFreshConversation, isTrue);
    });

    test('an older daemon keeps the old rule', () {
      expect(agent({'engine': 'devin'}).canPauseAndResume, isFalse);
      expect(agent({'engine': 'claude'}).canPauseAndResume, isFalse);
      expect(
        agent({'engine': 'claude', 'sessionId': 's'}).canPauseAndResume,
        isTrue,
      );
      expect(agent({'engine': 'terminal'}).canPauseAndResume, isTrue);
    });

    test('a word it does not know is not taken for one', () {
      expect(
        agent({'engine': 'devin', 'resumeMode': 'maybe'}).canPauseAndResume,
        isFalse,
      );
    });
  });
}
