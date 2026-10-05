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
  it('renders eighteen linked starter projects, with no fake engagement, and searches them', async () => {
    request.mockResolvedValue({ harnesses: [], nextCursor: null, following: [] });
    render(<Feed />);
    expect(screen.getAllByRole('link', { name: /^Open / }).filter(link => link.getAttribute('href')?.startsWith('/explore/starter-'))).toHaveLength(18);
    expect(screen.getByRole('link', { name: 'Open One more jump' })).toHaveAttribute('href', '/explore/starter-moonlight');
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
