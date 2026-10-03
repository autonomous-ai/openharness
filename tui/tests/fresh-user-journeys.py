"""Scenarios for fresh-user.py: real TUI actions, real agents and real folders.

Run `python3 tui/tests/fresh-user.py run` to install and exercise everything.
Set HN_FRESH_USER_CLI / HN_FRESH_USER_BINARY to test local release candidates.
No vendor credentials are copied: success means reaching the real onboarding UI.
The daemon API is used only to verify state, never to perform a product action.
"""
from pathlib import Path
import subprocess


def git(u, path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], env=u.env,
                                   text=True, stderr=subprocess.STDOUT, timeout=20).strip()


def repository(u, name, branch='main', committed=True):
    path = u.home / 'Projects' / name
    path.mkdir(parents=True)
    git(u, path, 'init', '-b', branch)
    git(u, path, 'config', 'user.name', 'Harness Test')
    git(u, path, 'config', 'user.email', 'harness-test@example.invalid')
    if committed:
        (path / 'README.md').write_text('Fresh-user Git fixture\n')
        git(u, path, 'add', 'README.md')
        git(u, path, 'commit', '-m', 'Initial fixture')
    return path


def options(u):
    u.wait('Worktree')


def rejected(u, text, label):
    count = len(u.status()['sessions'])
    u.keys('Enter')
    u.wait(text, 90)
    assert len(u.status()['sessions']) == count, 'A refused launch created an agent'
    u.record(label)


def core(u):
    u.wait('C-b N new', 60)
    assert not u.status()['signedIn']
    for name in ['codex', 'claude']:
        assert not (u.home / '.local/bin' / name).exists()
    u.record('signed-out-start')
    u.form()
    u.launch('codex', 'codex-auto-install-default-folder')
    assert (u.home / '.local/bin/codex').exists()

    u.form('claude')
    u.project('new folder', 'My First Claude Project')
    session = u.launch('claude', 'claude-auto-install-named-folder')
    assert session['cwd'] == '~/harnesses/My-First-Claude-Project'
    assert (u.home / '.local/bin/claude').exists()

    folder = u.home / "Projects/Notes & 'quotes' café"
    folder.mkdir(parents=True)
    (folder / 'keep-me.txt').write_text('fresh-user folder fixture\n')
    u.form('terminal')
    u.project('open folder', str(folder))
    before = {s['id'] for s in u.status()['sessions']}
    u.keys('Enter')
    u.check(lambda: len([s for s in u.status()['sessions'] if s['id'] not in before]) == 1,
            'Third pane created', 60)
    # Keep all three splits visible to catch sub-40-column terminal_open regressions.
    u.wait('Terminal on', 60)
    assert 'TERMINAL_OPEN_INVALID' not in u.screen()
    u.keys('C-c')
    u.text("printf 'OPEN_%s_OK\\n' FOLDER; pwd > ~/open-folder-cwd.txt")
    u.keys('Enter')
    u.wait('OPEN_FOLDER_OK')
    assert (u.home / 'open-folder-cwd.txt').read_text().strip() == str(folder)
    assert (folder / 'keep-me.txt').read_text() == 'fresh-user folder fixture\n'
    u.record('open-folder-special-characters-third-pane')
    u.zoom()
    u.close_view()


def folders(u):
    u.form('codex')
    u.project('new folder', 'My First Claude Project')
    rejected(u, 'Select that folder', 'existing-folder-protected')
    u.keys('Escape')
    u.form()
    u.wait('Select that folder')
    u.record('failed-draft-restored')
    u.project('new folder', 'Retry Project')
    session = u.launch('codex', 'folder-error-corrected', double_enter=True)
    assert session['cwd'] == '~/harnesses/Retry-Project'
    u.close_view()

    # Defaults allocate another folder rather than sharing one created in the same minute.
    names = set((u.home / 'harnesses').iterdir())
    u.form('codex')
    u.project('new folder', '')
    session = u.launch('codex', 'blank-folder-name-unique')
    assert len(set((u.home / 'harnesses').iterdir()) - names) == 1
    u.close_view()

    # Invalid paths remain in the picker and can be corrected without dismissing the form.
    u.form('codex')
    u.choose('Project', 'open folder', 'Search projects')
    u.wait('Choose a machine'); u.keys('Enter'); u.wait('Use this folder')
    u.keys('C-l', 'C-u'); u.text(str(u.home / 'does-not-exist')); u.keys('Enter')
    u.wait('Could not')
    u.record('missing-folder-browse-error')
    u.keys('C-l', 'C-u'); u.text('~/harnesses/Retry-Project'); u.keys('Enter')
    u.wait('Use this folder'); u.keys('Enter')
    session = u.launch('codex', 'tilde-path-recovery-agent-reuse')
    assert session['cwd'] == '~/harnesses/Retry-Project'
    u.close_view()


def clones(u):
    u.form('codex')
    u.project('clone', 'https://example.invalid/repo')
    rejected(u, 'Enter a GitHub', 'invalid-repository-actionable')
    u.project('clone', 'octocat/hn-fresh-user-no-such-repository-20260930')
    rejected(u, 'Could not', 'missing-repository-rejected')
    assert not list((u.home / 'harnesses').glob('.harness-clone-*'))
    u.project('clone', 'octocat/Hello-World')
    session = u.launch('codex', 'clone-owner-repository')
    repo = u.home / 'harnesses/Hello-World'
    assert session['cwd'] == '~/harnesses/Hello-World'
    assert git(u, repo, 'remote', 'get-url', 'origin') == 'https://github.com/octocat/Hello-World.git'
    assert (repo / 'README').is_file()
    head = git(u, repo, 'rev-parse', 'HEAD')
    u.close_view()
    u.form('claude')
    u.project('clone', 'https://github.com/octocat/Hello-World.git')
    rejected(u, 'Select that folder', 'clone-collision-protected')
    assert git(u, repo, 'rev-parse', 'HEAD') == head
    # A separate small public repository exercises HTTPS success too.
    u.project('clone', 'https://github.com/octocat/Spoon-Knife.git')
    u.launch('claude', 'clone-https-repository')
    assert (u.home / 'harnesses/Spoon-Knife/.git').is_dir()
    u.close_view()


def worktrees(u):
    repo = repository(u, 'Main Repository')
    git(u, repo, 'branch', 'feature')
    (repo / 'README.md').write_text('Uncommitted user work\n')
    u.form('codex'); u.project('open folder', str(repo))
    u.check(lambda: 'Checking Git' not in u.screen(), 'Git discovery')
    session = u.launch('codex', 'default-worktree-from-main')
    path = Path(session['cwd'].replace('~', str(u.home), 1))
    assert path != repo and '/worktrees/' in str(path)
    assert git(u, path, 'rev-parse', 'HEAD') == git(u, repo, 'rev-parse', 'main')
    assert (repo / 'README.md').read_text() == 'Uncommitted user work\n'
    assert (path / 'README.md').read_text() == 'Fresh-user Git fixture\n'
    u.close_view()

    u.form('claude'); u.project('open folder', str(repo)); options(u)
    u.choose('Branch', 'feature', 'Search or create a branch')
    session = u.launch('claude', 'existing-branch-worktree', click_create=True)
    path = Path(session['cwd'].replace('~', str(u.home), 1))
    assert '/worktrees/Main Repository/' in str(path)
    assert git(u, path, 'branch', '--show-current') == 'feature'
    assert (repo / 'README.md').read_text() == 'Uncommitted user work\n'
    u.close_view()

    empty = repository(u, 'Empty Repository', committed=False)
    u.form('codex'); u.project('open folder', str(empty))
    rejected(u, 'Choose a branch', 'empty-repository-worktree-guidance')
    options(u); u.field('Worktree')
    session = u.launch('codex', 'empty-repository-worktree-off', click_create=True)
    assert session['cwd'] == '~/Projects/Empty Repository'
    assert not (empty / '.git/refs/heads/main').exists()
    u.close_view()


def narrow_cancel(u):
    before = len(u.status()['sessions'])
    u.form('claude'); u.project('new folder', 'Keep Draft')
    for width, height in [(80, 24), (45, 14), (22, 5), (1, 1), (130, 38)]:
        u.outer('resize-window', '-t', 'user', '-x', str(width), '-y', str(height))
        u.check(lambda: bool(u.native('display-message', '-p', '#{window_panes}')), 'TUI remains responsive')
    u.wait('Keep Draft')
    u.keys('Escape'); u.form(); u.wait('Keep Draft')
    u.record('resize-and-cancel-preserve-draft')
    u.keys('Escape')
    assert len(u.status()['sessions']) == before
    assert not (u.home / 'harnesses/Keep-Draft').exists()


def git_edges(u):
    master = repository(u, 'Master Repository', branch='master')
    u.form('codex'); u.project('open folder', str(master))
    rejected(u, 'Choose a branch', 'repository-without-main-guidance')
    options(u); u.choose('Branch', 'master', 'Search or create a branch')
    session = u.launch('codex', 'explicit-master-worktree', click_create=True)
    path = Path(session['cwd'].replace('~', str(u.home), 1))
    assert git(u, path, 'rev-parse', 'HEAD') == git(u, master, 'rev-parse', 'master')
    u.close_view()

    repo = repository(u, 'Dirty Repository')
    git(u, repo, 'branch', 'feature')
    (repo / 'README.md').write_text('Unsaved user work\n')
    u.form('codex'); u.project('open folder', str(repo)); options(u)
    u.field('Worktree'); u.choose('Branch', 'new-topic', 'Search or create a branch')
    session = u.launch('codex', 'new-branch-in-existing-folder', click_create=True)
    assert session['cwd'] == '~/Projects/Dirty Repository'
    assert git(u, repo, 'branch', '--show-current') == 'new-topic'
    assert (repo / 'README.md').read_text() == 'Unsaved user work\n'
    u.close_view()

    u.form('codex'); u.project('open folder', str(repo)); options(u)
    u.field('Worktree'); u.choose('Branch', 'feature', 'Search or create a branch')
    rejected(u, 'uncommitted changes', 'dirty-branch-switch-protected')
    assert git(u, repo, 'branch', '--show-current') == 'new-topic'
    assert (repo / 'README.md').read_text() == 'Unsaved user work\n'
    u.field('Worktree')
    u.choose('Branch', 'feature', 'Search or create a branch')
    session = u.launch('codex', 'dirty-switch-recovered-with-worktree', click_create=True)
    path = Path(session['cwd'].replace('~', str(u.home), 1))
    assert git(u, path, 'branch', '--show-current') == 'feature'
    assert (repo / 'README.md').read_text() == 'Unsaved user work\n'
    u.close_view()


def run(u, names):
    cases = dict(core=core, folders=folders, clones=clones, worktrees=worktrees,
                 git_edges=git_edges, narrow=narrow_cancel)
    for name in names or cases:
        print('RUN ' + name, flush=True)
        try:
            cases[name](u)
        except Exception:
            u.snapshot('failure-' + name)
            raise
    print('Evidence: ' + str(u.root / 'results.json'), flush=True)
