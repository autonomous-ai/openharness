import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Feed from './Feed';
import Detail from './Detail';
import { CommunityError, emptySocial } from '@/lib/community/client';
import type { OpenHarness } from '@/lib/community/types';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/community/client', async importActual => ({ ...await importActual<typeof import('@/lib/community/client')>(), communityRequest: request }));
const sample: OpenHarness = { id: 'starter-orbit', title: 'Orbit', description: 'A small model', category: 'Experiments', engine: 'Codex', authorId: 'harness', authorName: 'Harness', createdAt: '2026-10-05', files: [{ path: 'index.html', content: '<h1>Orbit</h1>' }], viewerPath: 'index.html', conversation: [{ role: 'user', text: 'Make an orbit.' }], example: true };
beforeEach(() => request.mockReset());
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
  it('renders eighteen linked starter projects, with no fake engagement, and searches them', async () => {
    request.mockResolvedValue({ harnesses: [], nextCursor: null, following: [] });
    render(<Feed />);
    expect(screen.getAllByRole('link', { name: /^Open / }).filter(link => link.getAttribute('href')?.startsWith('/hub/starter-'))).toHaveLength(18);
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
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}`);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like harness' })).toHaveTextContent('3'));
    expect(request).toHaveBeenLastCalledWith(`harnesses/${id}/social`);
  });
  it('still loads beside a backend that has no social route yet', async () => {
    request.mockRejectedValueOnce(new CommunityError('Not found.', 404)).mockResolvedValueOnce({ harness: null, social: { ...emptySocial, likes: 2 } });
    render(<Detail id={sample.id} initial={sample} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like harness' })).toHaveTextContent('2'));
    expect(request.mock.calls.map(call => call[0])).toEqual(['harnesses/starter-orbit/social', 'harnesses/starter-orbit']);
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
});
