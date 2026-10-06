import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishPage from './page';

vi.mock('@/lib/community/drafts', async importActual => ({ ...await importActual<typeof import('@/lib/community/drafts')>(), readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(async () => {}) }));
const mocks = vi.hoisted(() => ({ request: vi.fn(), push: vi.fn(), headers: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/community/client', () => ({ communityRequest: mocks.request, sessionHeaders: mocks.headers }));
const project = { version: 1, title: 'My orbit', description: 'A new perspective', category: 'Experiments', engine: 'Codex', viewerPath: 'index.html', files: [{ path: 'index.html', content: '<h1>My orbit</h1>' }], conversation: [{ role: 'user', text: 'Change the orbit.' }], forkedFrom: 'starter-orbit' };
beforeEach(() => { vi.clearAllMocks(); mocks.headers.mockReturnValue({ Authorization: 'Bearer fixture' }); });
describe('explicit publication', () => {
  it('imports a fork, previews it safely, and preserves attribution when publishing', async () => {
    mocks.request.mockResolvedValue({ id: 'published-fixture' });
    render(<PublishPage />);
    const file = Object.assign(new File([JSON.stringify(project)], 'OPEN-HARNESS.json', { type: 'application/json' }), { text: async () => JSON.stringify(project) });
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByDisplayValue('My orbit')).toBeInTheDocument());
    expect(screen.getByTitle('Publication preview')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish harness' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/hub/published-fixture'));
    expect(mocks.request.mock.calls[0][1].body).toMatchObject({ forkedFrom: 'starter-orbit', confirmed: true, license: 'MIT', files: project.files, conversation: project.conversation });
  });
  it('keeps a draft after a failed publication and requires sign-in', async () => {
    mocks.headers.mockReturnValue({}); render(<PublishPage />); await act(async () => {});
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Sign in to Harness' })).toBeInTheDocument();
    mocks.headers.mockReturnValue({ Authorization: 'Bearer fixture' }); fireEvent.focus(window);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Keep this draft' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My project' } });
    fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'Make it.' } });
    fireEvent.change(screen.getByLabelText('Upload HTML output'), { target: { files: [Object.assign(new File(['<h1>Test</h1>'], 'index.html'), { text: async () => '<h1>Test</h1>' })] } });
    await waitFor(() => expect(screen.getByTitle('Publication preview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox')); mocks.request.mockRejectedValue(new Error('Service unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish harness' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument(); expect(mocks.push).not.toHaveBeenCalled();
  });
});
