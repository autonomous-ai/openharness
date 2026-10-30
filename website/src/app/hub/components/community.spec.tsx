import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Feed from './Feed';
import Detail from './Detail';
import CreatorPage from './CreatorPage';
import ReportsPage from '../reports/page';
import NotificationsPage from '../notifications/page';
import { Header } from './Header';
import { CommunityError, emptySocial } from '@/lib/community/client';
import { starterHarnesses } from '@/lib/community/starters';
import type { OpenHarness } from '@/lib/community/types';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/community/client', async importActual => ({ ...await importActual<typeof import('@/lib/community/client')>(), communityRequest: request }));
const sample: OpenHarness = { id: 'starter-orbit', title: 'Orbit', description: 'A small model', category: 'Experiments', engine: 'Codex', authorId: 'harness', authorName: 'Harness', createdAt: '2026-10-05', files: [{ path: 'index.html', content: '<h1>Orbit</h1>' }], viewerPath: 'index.html', conversation: [{ role: 'user', text: 'Make an orbit.' }], example: true };
// A block, not an expression: vitest runs a function returned from beforeEach as the test's cleanup.
beforeEach(() => { request.mockReset(); });
describe('community navigation', () => {
  it('lets creators reply to a specific comment without replacing the output', async () => {
    const comment = { id: 'comment-1', body: 'How did you make this?', authorName: 'Bob', mine: false, createdAt: '2026-10-06' };
    request.mockResolvedValueOnce({ harness: null, social: { ...emptySocial, signedIn: true, mine: true, comments: [comment] } });
    render(<Detail id={sample.id} initial={sample} initialComments />);
    await screen.findByText('How did you make this?');
    const viewer = screen.getByTitle('Orbit output');
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Reply to Bob'), { target: { value: 'Start by changing the radius.' } });
    request.mockResolvedValueOnce({ comment: { ...comment, id: 'reply-1', body: 'Start by changing the radius.', authorName: 'Alice', mine: true, creator: true, parentId: comment.id, parentAuthorName: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
    await screen.findByText('Replying to Bob');
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith('harnesses/starter-orbit/comments', { method: 'POST', body: expect.objectContaining({ parentId: 'comment-1', body: 'Start by changing the radius.' }) });
    expect(screen.getByTitle('Orbit output')).toBe(viewer);
  });
  it('appends the next feed page once and preserves real social counts', async () => {
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'first' }], nextCursor: 'next-page', following: [], stats: { first: { likes: 7, comments: 2, liked: false } }, signedIn: true });
    render(<Feed mine />);
    await screen.findByRole('button', { name: 'More harnesses' });
    expect(screen.getByRole('button', { name: 'Like Orbit' })).toHaveTextContent('7');
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'first' }, { ...sample, id: 'second', title: 'Second' }], nextCursor: null, following: [], stats: {}, signedIn: true });
    fireEvent.click(screen.getByRole('button', { name: 'More harnesses' }));
    await screen.findByRole('link', { name: 'Open Second' });
    expect(screen.getAllByRole('link', { name: 'Open Orbit' })).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith('harnesses?mine=true&cursor=next-page');
  });
  it('renders seventeen linked starter projects, with no fake engagement, and searches them', async () => {
    request.mockResolvedValue({ harnesses: [], nextCursor: null, following: [] });
    render(<Feed />);
    // Nothing is drawn under the first page until it answers: the grid would jump when it lands.
    expect(screen.queryAllByRole('link', { name: /^Open / })).toHaveLength(0);
    await screen.findByRole('link', { name: 'Open One more jump' });
    expect(screen.getAllByRole('link', { name: /^Open / }).filter(link => link.getAttribute('href')?.startsWith('/hub/starter-'))).toHaveLength(17);
    expect(screen.getByRole('link', { name: 'Open One more jump' })).toHaveAttribute('href', '/hub/starter-moonlight');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search harnesses' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'orbit' } });
    // Publications are searched by the server, across every page; the starters are matched here.
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('harnesses?q=orbit'));
    expect(screen.getByRole('link', { name: 'Open A little perspective' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Blue hour' })).not.toBeInTheDocument();
    expect(window.location.search).toBe('?q=orbit');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('harnesses?'));
    expect(window.location.search).toBe('');
    expect(screen.getByRole('link', { name: 'Open Blue hour' })).toBeInTheDocument();
  });
  it('draws the starters after the last page, so paging never lands above them', async () => {
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'first' }], nextCursor: 'next-page', following: [], stats: {}, signedIn: true });
    render(<Feed />);
    await screen.findByRole('button', { name: 'More harnesses' });
    expect(screen.queryByRole('link', { name: 'Open Blue hour' })).not.toBeInTheDocument();
    // A search finds them at once: there is nothing to scroll past.
    request.mockResolvedValueOnce({ harnesses: [], nextCursor: null, following: [], stats: {}, signedIn: true });
    fireEvent.click(screen.getByRole('button', { name: 'Search harnesses' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'melody' } });
    await screen.findByRole('link', { name: 'Open Blue hour' });
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'first' }], nextCursor: 'next-page', following: [], stats: {}, signedIn: true });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Open Blue hour' })).not.toBeInTheDocument());
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'second', title: 'Second' }], nextCursor: null, following: [], stats: {}, signedIn: true });
    fireEvent.click(screen.getByRole('button', { name: 'More harnesses' }));
    await screen.findByRole('link', { name: 'Open Blue hour' });
    const links = screen.getAllByRole('link', { name: /^Open / }).map(link => link.getAttribute('href'));
    expect(links.indexOf('/hub/second')).toBeLessThan(links.indexOf('/hub/starter-blue-hour'));
  });
  it('reports a failed like without offering to reload the feed', async () => {
    request.mockResolvedValueOnce({ harnesses: [], nextCursor: null, following: [], stats: {}, signedIn: true });
    render(<Feed />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    request.mockRejectedValueOnce(new CommunityError('The community is temporarily unavailable. Try again.', 503));
    fireEvent.click(screen.getByRole('button', { name: 'Like Blue hour' }));
    await screen.findByText('The community is temporarily unavailable. Try again.');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
  it('offers Reply only to a signed-in reader', async () => {
    const comment = { id: 'comment-1', body: 'Lovely.', authorName: 'Bob', mine: false, createdAt: '2026-10-06' };
    request.mockResolvedValue({ social: { ...emptySocial, comments: [comment] } });
    render(<Detail id={sample.id} initial={sample} initialComments />);
    await screen.findByText('Lovely.');
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  });
  it('keeps the viewer in place while comments replace the chat and escape user text', async () => {
    request.mockResolvedValue({ harness: null, social: { ...emptySocial, comments: [{ id: 'c', body: '<img src=x onerror=alert(1)>', authorName: 'Someone', mine: false, createdAt: '2026-10-05' }] } });
    render(<Detail id={sample.id} initial={sample} />);
    const viewer = screen.getByTitle('Orbit output');
    expect(viewer).not.toHaveAttribute('sandbox', expect.stringContaining('allow-same-origin'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fork' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comments' })).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src=x]')).toBeNull();
    expect(screen.getByTitle('Orbit output')).toBe(viewer);
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat log' }));
    expect(screen.getByText('Make an orbit.')).toBeInTheDocument();
  });
  it('offers its author one Edit beside Fork, and a reader none', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    request.mockResolvedValueOnce({ harness: { ...sample, id }, social: { ...emptySocial, signedIn: true, mine: true } });
    const { unmount } = render(<Detail id={id} initial={null} />);
    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/hub/publish?edit=${id}`);
    // Unpublish lives in the edit, not beside the output.
    expect(screen.queryByRole('button', { name: 'Unpublish this harness' })).not.toBeInTheDocument();
    unmount();
    request.mockResolvedValueOnce({ harness: { ...sample, id }, social: { ...emptySocial, signedIn: true } });
    render(<Detail id={id} initial={null} />);
    await screen.findByTitle('Orbit output');
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });
  it('reads a page opened at its slug, then names the publication by its id and shows its own address', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e', slug = 'an-older-title-0f8fad5b';
    window.history.replaceState(null, '', `/hub/${slug}?comments=1`);
    try {
      request.mockResolvedValueOnce({ harness: { ...sample, id, example: false }, social: { ...emptySocial, signedIn: true } });
      render(<Detail id={slug} initial={null} />);
      await screen.findByTitle('Orbit output');
      expect(request).toHaveBeenCalledWith(`harnesses/${slug}?files=viewer`);
      // The address moves in an effect after the page draws.
      await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/hub/orbit-0f8fad5b?comments=1'));
      request.mockResolvedValueOnce({ liked: true, likes: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Like harness' }));
      await waitFor(() => expect(request).toHaveBeenLastCalledWith(`harnesses/${id}/like`, expect.anything()));
    } finally {
      // The next test reads the address: leave none behind, passed or failed.
      window.history.replaceState(null, '', '/');
    }
  });
  it('reads as loading, not failed, until the reader is known, and offers no action that would need them', async () => {
    request.mockReturnValueOnce(new Promise(() => {}));
    render(<Detail id={sample.id} initial={sample} initialComments />);
    expect(screen.getByLabelText('Loading comments')).toBeInTheDocument();
    expect(screen.queryByText(/Comments are unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign in to Harness/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Like harness' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
  });
  it('sends a phone’s Fork to the fork page, which has no app to open', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    render(<Detail id={sample.id} initial={sample} />);
    expect(screen.getByRole('link', { name: 'Fork' })).toHaveAttribute('href', '/hub/starter-orbit/fork');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
  });
  it('moves through the Share menu by keyboard and returns to its button on Escape', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    render(<Detail id={sample.id} initial={sample} />);
    const share = screen.getByRole('button', { name: 'Share' });
    fireEvent.keyDown(share, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Share on X' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Share on LinkedIn' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(share).toHaveFocus();
  });
  it('likes from a card before the first page answers when this browser holds a sign-in, and asks a visitor at the bottom of the screen', async () => {
    const page = { harnesses: [{ ...sample, id: 'first', title: 'Server card' }], nextCursor: null, following: [], stats: {} };
    request.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = render(<Feed initialPage={page} />);
    fireEvent.click(screen.getByRole('button', { name: 'Like Server card' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sign in to Harness to like harnesses and follow creators');
    unmount();
    localStorage.setItem('harness.web.v1.auth_access_token', 'token');
    request.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({ liked: true, likes: 1 });
    render(<Feed initialPage={page} />);
    fireEvent.click(screen.getByRole('button', { name: 'Like Server card' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('harnesses/first/like', expect.objectContaining({ method: 'PUT' })));
    localStorage.clear();
  });
  it('says so when a drawn page cannot load its likes and actions, and retries', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    request.mockRejectedValueOnce(new CommunityError('Service unavailable', 503));
    render(<Detail id={id} initial={{ ...sample, id }} />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    request.mockResolvedValueOnce({ social: { ...emptySocial, signedIn: true, mine: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });
  it('tells a browser whose sign-in the Hub no longer accepts to sign in again', async () => {
    localStorage.setItem('harness.web.v1.auth_access_token', 'expired-fixture');
    request.mockResolvedValueOnce({ harness: { ...sample, id: sample.id }, social: { ...emptySocial, signedIn: false } });
    render(<Detail id={sample.id} initial={null} />);
    expect(await screen.findByText(/Your sign-in has expired/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/');
    localStorage.clear();
  });
  it('reads a publication once, then refreshes only its social state', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    request.mockResolvedValueOnce({ harness: { ...sample, id }, social: emptySocial }).mockResolvedValue({ social: { ...emptySocial, likes: 3 } });
    render(<Detail id={id} initial={null} />);
    await screen.findByTitle('Orbit output');
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}?files=viewer`);
    // Coming back within half a minute (or clicking out of the output) reads nothing.
    act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(request).toHaveBeenCalledTimes(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like harness' })).toHaveTextContent('3'));
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}/social`);
    vi.restoreAllMocks();
  });
  it('still loads beside a backend that has no social route yet', async () => {
    request.mockRejectedValueOnce(new CommunityError('Not found.', 404)).mockResolvedValueOnce({ harness: null, social: { ...emptySocial, likes: 2 } });
    render(<Detail id={sample.id} initial={sample} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like harness' })).toHaveTextContent('2'));
    expect(request.mock.calls.map(call => call[0])).toEqual(['harnesses/starter-orbit/social', 'harnesses/starter-orbit?files=viewer']);
    expect(screen.queryByText('This harness is unavailable.')).not.toBeInTheDocument();
  });
  it('does not pretend a signed-out like succeeded', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    render(<Detail id={sample.id} initial={sample} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Like harness' }));
    expect(screen.getByRole('link', { name: 'Sign in to Harness' })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Like harness' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('waits for the server before changing a like count', async () => {
    request.mockResolvedValueOnce({ harness: null, social: { ...emptySocial, signedIn: true } });
    render(<Detail id={sample.id} initial={sample} />);
    await act(async () => {});
    request.mockResolvedValueOnce({ likes: 1, liked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Like harness' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlike harness' })).toHaveTextContent('1'));
    expect(request).toHaveBeenLastCalledWith('harnesses/starter-orbit/like', { method: 'PUT', body: { liked: true } });
  });
  it('narrows the feed by category and order, for publications and starters alike', async () => {
    request.mockResolvedValue({ harnesses: [], nextCursor: null, following: [], stats: {} });
    render(<Feed />);
    await screen.findByRole('link', { name: 'Open One more jump' });
    fireEvent.click(screen.getByRole('button', { name: 'Music' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('harnesses?category=Music'));
    expect(screen.getByRole('link', { name: 'Open Blue hour' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open One more jump' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Popular' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('harnesses?category=Music&sort=popular'));
    expect(window.location.search).toBe('?category=Music&sort=popular');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Newest' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('harnesses?'));
    expect(window.location.search).toBe('');
  });
  it('draws a popular feed in the order the server gave, the liked starters among the publications', async () => {
    request.mockResolvedValue({ harnesses: [{ ...sample, id: 'post', title: 'Published' }], order: ['starter-blue-hour', 'post', 'starter-orbit'], nextCursor: null, following: [], stats: {} });
    window.history.replaceState(null, '', '/hub?sort=popular');
    render(<Feed initialView={{ query: '', category: '', sort: 'popular' }} />);
    await screen.findByRole('link', { name: 'Open Published' });
    // Only what the server ranked, where it ranked it: no starter is appended after the publications.
    expect(screen.getAllByRole('link', { name: /^Open / }).map(link => link.getAttribute('href')))
      .toEqual(['/hub/starter-blue-hour', '/hub/published-post', '/hub/starter-orbit']);
    window.history.replaceState(null, '', '/');
  });
  it('holds a feed like until the server answers, and shows the forks a card has', async () => {
    request.mockResolvedValueOnce({ harnesses: [{ ...sample, id: 'first' }], nextCursor: null, following: [], stats: { first: { likes: 1, comments: 0, liked: false, forks: 2 } }, signedIn: true });
    render(<Feed mine />);
    await screen.findByRole('link', { name: 'Forks of Orbit' });
    let answer: (value: unknown) => void = () => {};
    request.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Like Orbit' }));
    expect(screen.getByRole('button', { name: 'Like Orbit' })).toBeDisabled();
    await act(async () => answer({ liked: true, likes: 2 }));
    expect(screen.getByRole('button', { name: 'Unlike Orbit' })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Unlike Orbit' })).toBeEnabled();
  });
  it('reads earlier comments a page at a time, and says when a page fails', async () => {
    const latest = { id: 'c2', body: 'Latest', authorName: 'Cy', mine: false, createdAt: '2026-10-07' };
    const earlier = { id: 'c1', body: 'Earlier', authorName: 'Bob', mine: false, createdAt: '2026-10-06' };
    request.mockResolvedValueOnce({ harness: null, social: { ...emptySocial, comments: [latest], commentCount: 2 } });
    render(<Detail id={sample.id} initial={sample} initialComments />);
    await screen.findByText('Showing the latest 1 of 2 comments.');
    request.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    await screen.findByText('Earlier comments could not be loaded.');
    request.mockResolvedValueOnce({ comments: [earlier], more: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Earlier');
    expect(request).toHaveBeenLastCalledWith('harnesses/starter-orbit/comments?before=c2');
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument();
  });
  it('counts every comment, threads replies, and lists the forks', async () => {
    const parent = { id: 'c1', body: 'First', authorName: 'Bob', mine: false, createdAt: '2026-10-06' };
    const other = { id: 'c2', body: 'Second', authorName: 'Cy', mine: false, createdAt: '2026-10-07' };
    const reply = { id: 'c3', body: 'Reply', authorName: 'Alice', mine: false, createdAt: '2026-10-08', parentId: 'c1', parentAuthorName: 'Bob' };
    request.mockImplementation(async (path: string) => { return path.startsWith('harnesses?')
      ? { harnesses: [{ ...sample, id: 'fork-1', title: 'My orbit' }], nextCursor: null, following: [], stats: {} }
      : { harness: null, social: { ...emptySocial, comments: [parent, other, reply], commentCount: 140, forks: 1 } }; });
    render(<Detail id={sample.id} initial={sample} initialComments />);
    await screen.findByText('Showing the latest 3 of 140 comments.');
    expect(screen.getByRole('heading', { name: 'Comments · 140' })).toBeInTheDocument();
    expect(screen.getAllByText(/^(First|Second|Reply)$/).map(node => node.textContent)).toEqual(['First', 'Reply', 'Second']);
    expect(screen.getByRole('link', { name: '1 fork' })).toHaveAttribute('href', '#forks');
    await screen.findByRole('link', { name: 'Open My orbit' });
    expect(request).toHaveBeenCalledWith('harnesses?forkedFrom=starter-orbit');
  });
  it('reads source files only when the reader opens them', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ version: 1, harness: { ...sample, files: [...sample.files, { path: 'src/orbit.js', content: 'const radius = 3;' }] } }));
    render(<Detail id={sample.id} initial={sample} />);
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Source files' }));
    await screen.findByText('src/orbit.js');
    expect(fetcher).toHaveBeenCalledWith('/hub/starter-orbit/snapshot', { cache: 'no-store' });
    expect(screen.queryByText('const radius = 3;')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('src/orbit.js'));
    expect(await screen.findByText('const radius = 3;')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Source files' }));
    expect(screen.getByText('Make an orbit.')).toBeInTheDocument();
    fetcher.mockRestore();
  });
  it('shares from a menu: the link copied, or a network’s own share page', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Detail id={sample.id} initial={sample} />);
    const share = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(share);
    expect(share).toHaveAttribute('aria-expanded', 'true');
    const link = encodeURIComponent(`${window.location.origin}/hub/starter-orbit`);
    expect(screen.getByRole('menuitem', { name: 'Share on X' })).toHaveAttribute('href', `https://x.com/intent/tweet?text=Orbit&url=${link}`);
    expect(screen.getByRole('menuitem', { name: 'Share on Facebook' })).toHaveAttribute('href', `https://www.facebook.com/sharer/sharer.php?u=${link}`);
    expect(screen.getByRole('menuitem', { name: 'Share on LinkedIn' })).toHaveAttribute('target', '_blank');
    // No share sheet in this browser: nothing offers one.
    expect(screen.queryByRole('menuitem', { name: 'More options…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await screen.findByText('Link copied');
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/hub/starter-orbit`);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('draws the page the server read at once, then reads it again with the reader’s sign-in', async () => {
    let answer: (page: unknown) => void = () => {};
    request.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const page = { harnesses: [{ ...sample, id: 'first', title: 'Server card' }], nextCursor: null, following: [], stats: { first: { likes: 4, comments: 1, liked: false } } };
    render(<Feed initialPage={page} />);
    expect(screen.getByRole('link', { name: 'Open Server card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Like Server card' })).toHaveTextContent('4');
    await act(async () => { answer({ ...page, stats: { first: { likes: 4, comments: 1, liked: true } }, signedIn: true }); });
    expect(screen.getByRole('button', { name: 'Unlike Server card' })).toBeInTheDocument();
  });
  it.each([
    [{ forkedFrom: '8f0c2a1e-5b6d-4c3a-9e7f-1a2b3c4d5e6f', origin: { title: 'The original', authorName: 'Alice' } }, 'Forked from The original by Alice', true],
    [{ forkedFrom: 'starter-orbit' }, `Forked from ${starterHarnesses.find(item => item.id === 'starter-orbit')!.title} by Harness`, true],
    [{ forkedFrom: '8f0c2a1e-5b6d-4c3a-9e7f-1a2b3c4d5e6f', origin: null }, 'Forked from a harness that is no longer published', false],
  ])('names where a fork came from: %o', async (fork, words, linked) => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    render(<Detail id="11111111-2222-4333-8444-555555555555" initial={{ ...sample, id: '11111111-2222-4333-8444-555555555555', example: false, ...fork }} />);
    expect(screen.getByText(words).closest('a') !== null).toBe(linked);
  });
  it('reads an edited publication again when a refresh says its author changed it', async () => {
    const id = '11111111-2222-4333-8444-555555555555', drawn = { ...sample, id, example: false, updatedAt: null };
    request.mockResolvedValueOnce({ social: { ...emptySocial, updatedAt: null } });
    render(<Detail id={id} initial={drawn} />);
    await act(async () => {});
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}/social`);
    request.mockResolvedValueOnce({ social: { ...emptySocial, updatedAt: '2026-10-15T08:00:00.000Z' } })
      .mockResolvedValueOnce({ harness: { ...drawn, title: 'Edited', updatedAt: '2026-10-15T08:00:00.000Z' }, social: emptySocial });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { name: 'Edited' })).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}?files=viewer`);
  });
  it('shows a creator’s page: who they are, their harnesses, and following them', async () => {
    const creator = { id: 'alice', name: 'Alice', followers: 1, following: false, mine: false, signedIn: true };
    request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PUT') return { following: true };
      if (path.startsWith('creators/')) return { creator };
      return { harnesses: [{ ...sample, id: 'mine-1', title: 'Her harness', authorId: 'alice', authorName: 'Alice', example: false }], nextCursor: null, following: [], stats: {}, signedIn: true };
    });
    render(<CreatorPage id="alice" initial={creator} initialView={{ query: '', category: '', sort: 'newest' }} />);
    expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument();
    await screen.findByRole('link', { name: 'Open Her harness' });
    expect(request).toHaveBeenCalledWith('harnesses?author=alice');
    expect(screen.getAllByRole('link', { name: 'Alice' })[0]).toHaveAttribute('href', '/hub/creators/alice');
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await screen.findByRole('button', { name: 'Following' });
    expect(screen.getByText('2 followers')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('creators/alice/follow', { method: 'PUT', body: { following: true } });
  });
  it('says a creator is unavailable when the Hub has no such creator', async () => {
    request.mockRejectedValue(new CommunityError('This creator is unavailable.', 404));
    render(<CreatorPage id="nobody" initial={null} initialView={{ query: '', category: '', sort: 'newest' }} />);
    expect(await screen.findByRole('heading', { name: 'This creator is unavailable.' })).toBeInTheDocument();
  });
  it('reports a harness with one reason, and leaves the reporter a page that says so', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    request.mockResolvedValueOnce({ social: { ...emptySocial, signedIn: true } });
    render(<Detail id={id} initial={{ ...sample, id, example: false }} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Report harness' }));
    const report = screen.getByRole('button', { name: 'Report' });
    expect(report).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Spam'));
    request.mockResolvedValueOnce({ reported: true });
    fireEvent.click(report);
    expect(await screen.findByRole('heading', { name: 'Thanks for reporting.' })).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith('reports', { method: 'POST', body: { targetType: 'harness', targetId: id, reason: 'spam' } });
  });
  it('offers no report on a starter or your own harness', async () => {
    request.mockResolvedValue({ harness: null, social: { ...emptySocial, signedIn: true } });
    render(<Detail id={sample.id} initial={sample} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Report harness' })).not.toBeInTheDocument();
  });
  it('takes a reported comment off the reporter’s page at once', async () => {
    const comment = { id: 'c1', body: 'Buy now', authorName: 'Spammer', mine: false, createdAt: '2026-10-06' };
    request.mockResolvedValueOnce({ harness: null, social: { ...emptySocial, signedIn: true, comments: [comment], commentCount: 1 } });
    render(<Detail id={sample.id} initial={sample} initialComments />);
    await screen.findByText('Buy now');
    fireEvent.click(screen.getByRole('button', { name: 'Report comment by Spammer' }));
    fireEvent.click(screen.getByLabelText('Harassment or hate'));
    request.mockResolvedValueOnce({ reported: true });
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(screen.queryByText('Buy now')).not.toBeInTheDocument());
    expect(request).toHaveBeenLastCalledWith('reports', { method: 'POST', body: { targetType: 'comment', targetId: 'c1', reason: 'harassment' } });
  });
  it('shows reviewers what was reported, and nobody else', async () => {
    request.mockRejectedValueOnce(new CommunityError('Admin only', 403));
    const { unmount } = render(<ReportsPage />);
    expect(await screen.findByText('Only the Hub’s reviewers can see reports.')).toBeInTheDocument();
    unmount();
    const item = { targetType: 'harness', targetId: 'h1', harnessId: 'h1', reports: 3, lastReportedAt: '2026-10-15', reasons: { spam: 2, other: 1 }, state: 'hidden', text: 'Spam page', authorName: 'Mallory' };
    request.mockResolvedValueOnce({ reports: [item] });
    render(<ReportsPage />);
    expect(await screen.findByText('Spam page — Mallory')).toBeInTheDocument();
    expect(screen.getByText('Spam 2 · Something else 1')).toBeInTheDocument();
    request.mockResolvedValueOnce({ reviewed: true }).mockResolvedValueOnce({ reports: [{ ...item, state: 'restored' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/Restored/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('reports/review', { method: 'POST', body: { targetType: 'harness', targetId: 'h1', decision: 'restore' } });
  });
  it('signs a visitor in at the web app and brings them back to the Hub page they were on', async () => {
    window.history.replaceState(null, '', '/hub/following');
    try {
      render(<Header />);
      const signIn = await screen.findByRole('link', { name: 'Sign in' });
      expect(signIn).toHaveAttribute('href', '/');
      signIn.addEventListener('click', event => event.preventDefault());
      fireEvent.click(signIn);
      expect(sessionStorage.getItem('harness.hub.returnTo')).toBe('/hub/following');
    } finally {
      sessionStorage.clear();
      window.history.replaceState(null, '', '/');
    }
  });
  it('rings the bell with the unread count only for someone signed in', async () => {
    const { unmount } = render(<Header />);
    await act(async () => {});
    expect(screen.queryByRole('link', { name: /Notifications/ })).not.toBeInTheDocument();
    unmount();
    localStorage.setItem('harness.web.v1.auth_access_token', 'token');
    request.mockResolvedValueOnce({ unread: 3 });
    render(<Header />);
    expect(await screen.findByRole('link', { name: 'Notifications, 3 unread' })).toHaveAttribute('href', '/hub/notifications');
    expect(request).toHaveBeenCalledWith('notifications/unread');
    localStorage.clear();
  });
  it('lists notifications where they lead, and marks them read', async () => {
    const at = '2026-10-15T08:00:00.000Z';
    request.mockResolvedValueOnce({ unread: 2, notifications: [
      { id: 'n1', kind: 'fork', harnessId: 'h1', harnessTitle: 'Orbit', actorName: 'Bob', targetId: 'f1', createdAt: at, read: false },
      { id: 'n2', kind: 'reply', harnessId: 'h1', harnessTitle: 'Orbit', actorName: 'Cy', targetId: 'c1', createdAt: at, read: false },
      { id: 'n3', kind: 'comment', harnessId: 'h2', harnessTitle: 'Lamp', actorName: 'Di', targetId: 'c2', createdAt: at, read: true },
    ] }).mockResolvedValueOnce({ read: 2 });
    render(<NotificationsPage />);
    expect(await screen.findByRole('link', { name: /Bob forked Orbit/ })).toHaveAttribute('href', '/hub/f1');
    expect(screen.getByRole('link', { name: /Cy replied to your comment on Orbit/ })).toHaveAttribute('href', '/hub/orbit-h1?comments=1');
    expect(screen.getByRole('link', { name: /Di commented on Lamp/ })).toHaveAttribute('href', '/hub/lamp-h2?comments=1');
    await waitFor(() => expect(request).toHaveBeenCalledWith('notifications/read', { method: 'POST' }));
  });
  it('offers the device’s own share sheet in the menu where there is one, and closes on a click outside', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<Detail id={sample.id} initial={sample} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'More options…' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'Orbit', url: `${window.location.origin}/hub/starter-orbit` }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  });
});
