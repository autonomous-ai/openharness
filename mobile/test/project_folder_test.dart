import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/project_folder.dart';

void main() {
  group('what the machine is told', () {
    test('a new project asks for one and names nothing', () {
      expect(const ProjectFolderRequest.newProject().payload, {
        'projectSource': 'new',
      });
    });

    test('a repository travels as its canonical clone URL', () {
      final repo = GitHubRepository.parse('owner/repo')!;
      expect(ProjectFolderRequest.remote(repo).payload, {
        'projectSource': 'remote',
        'repositoryUrl': 'https://github.com/owner/repo.git',
      });
    });

    test('neither payload carries a cwd', () {
      // ⚠️ `createAgent` drops `cwd` when a request is present, so a stray path here would be the
      // second answer to a question that takes one — and the machine would have to guess.
      final repo = GitHubRepository.parse('owner/repo')!;
      for (final request in [
        const ProjectFolderRequest.newProject(),
        ProjectFolderRequest.remote(repo),
      ]) {
        expect(request.payload.containsKey('cwd'), isFalse);
      }
    });
  });

  group('parsing what someone pasted', () {
    test('the three shapes a person actually pastes', () {
      for (final input in [
        'owner/repo',
        'https://github.com/owner/repo',
        'https://github.com/owner/repo.git',
        '  owner/repo/  ',
      ]) {
        final repo = GitHubRepository.parse(input);
        expect(repo?.url, 'https://github.com/owner/repo.git', reason: input);
        expect(repo?.name, 'repo', reason: input);
      }
    });

    test('an ssh remote stays ssh', () {
      final repo = GitHubRepository.parse('git@github.com:owner/repo.git');
      expect(repo?.url, 'git@github.com:owner/repo.git');
      expect(repo?.name, 'repo');
    });

    test('anything that could smuggle something into git clone is refused', () {
      // ⚠️ The result is handed to a machine that runs `git clone` with it. Each of these is a way
      // to make that command reach somewhere other than the repository it appears to name, so they
      // are refused whole rather than trimmed and accepted.
      for (final input in [
        'https://evil.com/owner/repo',
        'https://user:pass@github.com/owner/repo',
        'https://github.com:22/owner/repo',
        'https://github.com/owner/repo?x=1',
        'https://github.com/owner/repo#frag',
        'http://github.com/owner/repo',
        'owner',
        'owner/repo/extra',
        'owner/..',
        '',
      ]) {
        expect(GitHubRepository.parse(input), isNull, reason: input);
      }
    });
  });
}
