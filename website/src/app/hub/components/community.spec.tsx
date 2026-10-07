import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Feed from './Feed';
import Detail from './Detail';
import { emptySocial } from '@/lib/community/client';
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
    expect(screen.getByRole('link', { name: 'Open A little perspective' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Blue hour' })).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalled());
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
