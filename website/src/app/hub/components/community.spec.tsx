import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Feed from './Feed';
import Detail from './Detail';
import { CommunityError, emptySocial } from '@/lib/community/client';
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
  it('copies the harness link', async () => {
    request.mockResolvedValue({ harness: null, social: emptySocial });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Detail id={sample.id} initial={sample} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to this harness' }));
    await screen.findByText('Link copied');
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/hub/starter-orbit`);
  });
});
