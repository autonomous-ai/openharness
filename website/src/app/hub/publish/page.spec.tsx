import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishPage from './page';
import { readDraft } from '@/lib/community/drafts';

vi.mock('@/lib/community/drafts', async importActual => ({ ...await importActual<typeof import('@/lib/community/drafts')>(), readDraft: vi.fn(async () => undefined), saveDraft: vi.fn(async () => {}) }));
const mocks = vi.hoisted(() => ({ request: vi.fn(), push: vi.fn(), headers: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/community/client', () => ({ communityRequest: mocks.request, sessionHeaders: mocks.headers }));
const project = { version: 1, title: 'My orbit', description: 'A new perspective', category: 'Experiments', engine: 'Codex', viewerPath: 'index.html', files: [{ path: 'index.html', content: '<h1>My orbit</h1>' }], conversation: [{ role: 'user', text: 'Change the orbit.' }], forkedFrom: 'starter-orbit' };
/** The Hub as it answers by default: a draft already in English, your publications (none), and a publication's id. */
const hub = (english?: object, mine: object[] = []) => async (path: string, options?: { body?: unknown }) =>
  path === 'translate' ? (english ? { ...english, translated: true } : { ...options?.body as object, translated: false })
    : path === 'harnesses?mine=true' ? { harnesses: mine } : { id: 'published-fixture' };
const tankId = '11111111-2222-4333-8444-555555555555';
const tank = { id: tankId, title: 'TANK 1987', description: 'A tank game', category: 'Experiments', engine: 'Codex', viewerPath: 'tank/index.html', files: [{ path: 'tank/index.html', content: '<canvas></canvas><script>go()</script>' }], conversation: [{ role: 'user', text: 'Make a tank game.' }], cover: `/api/community/harnesses/${tankId}/cover?v=1` };
const saved = (id: string) => mocks.request.mock.calls.find(([path, options]) => path === `harnesses/${id}` && options?.method === 'PUT');
const published = () => mocks.request.mock.calls.filter(([path]) => path === 'harnesses');
const translations = () => mocks.request.mock.calls.filter(([path]) => path === 'translate');
const bundleFile = (bundle: object) => Object.assign(new File([JSON.stringify(bundle)], 'OPEN-HARNESS.json', { type: 'application/json' }), { text: async () => JSON.stringify(bundle) });
beforeEach(() => { vi.clearAllMocks(); mocks.headers.mockReturnValue({ Authorization: 'Bearer fixture' }); mocks.request.mockImplementation(hub()); });
describe('explicit publication', () => {
  it('imports a fork, previews it safely, and preserves attribution when publishing', async () => {
    render(<PublishPage />);
    const file = Object.assign(new File([JSON.stringify(project)], 'OPEN-HARNESS.json', { type: 'application/json' }), { text: async () => JSON.stringify(project) });
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByDisplayValue('My orbit')).toBeInTheDocument());
    expect(screen.getByTitle('Publication preview')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    expect(published()).toHaveLength(0);
    expect(screen.getByText(/index.html is still the original/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Upload HTML output'), { target: { files: [Object.assign(new File(['<h1>My new orbit</h1>'], 'index.html'), { text: async () => '<h1>My new orbit</h1>' })] } });
    await waitFor(() => expect(screen.queryByText(/still the original/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish harness' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/hub/my-orbit-publishe'));
    expect(published()[0][1].body).toMatchObject({ forkedFrom: 'starter-orbit', confirmed: true, license: 'MIT', files: [{ path: 'index.html', content: '<h1>My new orbit</h1>' }], conversation: project.conversation });
    expect(published()[0][1].body).not.toHaveProperty('originalOutput');
    expect(published()[0][1].body).not.toHaveProperty('english');
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
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ })); mocks.request.mockRejectedValue(new Error('Service unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish harness' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument(); expect(mocks.push).not.toHaveBeenCalled();
  });
  it('holds back a publication that looks like it carries a credential or lacks its harness source', async () => {
    render(<PublishPage />);
    const bundle = { ...project, harnessId: 'autonomous/blender', files: [...project.files, { path: 'config.json', content: '{ "apiKey": "abcd1234efgh5678" }' }] };
    const file = Object.assign(new File([JSON.stringify(bundle)], 'OPEN-HARNESS.json', { type: 'application/json' }), { text: async () => JSON.stringify(bundle) });
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [file] } });
    await screen.findByText('config.json looks like it holds a password or secret.');
    expect(screen.getByText(/This harness needs scenes\/hello.py/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /None of them is a real credential/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Upload HTML output'), { target: { files: [Object.assign(new File(['<h1>Mine</h1>'], 'index.html'), { text: async () => '<h1>Mine</h1>' })] } });
    await waitFor(() => expect(screen.queryByText(/still the original/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeEnabled();
  });
  it('never assumes an app page is the output, and says what a chosen page cannot load', async () => {
    render(<PublishPage />); await act(async () => {});
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Code review' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'What changed and why' } });
    fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'Review this.' } });
    const folder = [['index.html', '<script src="app.js"></script>'], ['app.js', 'go()']].map(([path, text]) => Object.assign(new File([text], path), { webkitRelativePath: `project/${path}`, text: async () => text }));
    fireEvent.change(screen.getByLabelText('Choose project folder'), { target: { files: folder } });
    await screen.findByText(/The Hub shows what a session made/);
    expect(screen.queryByTitle('Publication preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: /^Output preview/ }), { target: { value: 'index.html' } });
    expect(await screen.findByText(/Your output loads app.js/)).toBeInTheDocument();
    expect(screen.queryByText(/The Hub shows what a session made/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeEnabled();
  });
  it('shows a one-file game as the output without asking for a preview.html', async () => {
    render(<PublishPage />); await act(async () => {});
    const game = '<canvas></canvas><script>requestAnimationFrame(function loop(){requestAnimationFrame(loop)})</script>';
    const folder = [['docs/guide.html', '<p>Guide</p>'], ['snake/index.html', game], ['notes.md', '# Snake']].map(([path, text]) => Object.assign(new File([text], path), { webkitRelativePath: `project/${path}`, text: async () => text }));
    fireEvent.change(screen.getByLabelText('Choose project folder'), { target: { files: folder } });
    expect(await screen.findByTitle('Publication preview')).toBeInTheDocument();
    expect(screen.queryByText(/The Hub shows what a session made/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your output loads/)).not.toBeInTheDocument();
  });
  it('opens one of your publications to edit and saves it over the same address', async () => {
    window.history.replaceState(null, '', `/hub/publish?edit=${tankId}`);
    const answer = hub(undefined, [{ id: tankId, title: tank.title }]);
    mocks.request.mockImplementation(async (path: string, options?: { body?: unknown }) => path === `harnesses/${tankId}` && !options ? { harness: tank, social: {} } : answer(path, options));
    render(<PublishPage />);
    expect(await screen.findByDisplayValue('TANK 1987')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Update your harness.' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'TANK 1987 II' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/hub/tank-1987-ii-11111111'));
    expect(saved(tankId)![1].body).toMatchObject({ title: 'TANK 1987 II', viewerPath: 'tank/index.html', files: tank.files, confirmed: true, license: 'MIT' });
    // The cover stays as it is: its address is not an image to send back.
    expect(saved(tankId)![1].body).not.toHaveProperty('cover');
    expect(published()).toHaveLength(0);
    expect(translations()).toHaveLength(0);
    window.history.replaceState(null, '', '/');
  });
  it('unpublishes from the edit, after asking, and only there', async () => {
    render(<PublishPage />); await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Unpublish this harness' })).not.toBeInTheDocument();
    cleanup();
    window.history.replaceState(null, '', `/hub/publish?edit=${tankId}`);
    const answer = hub(undefined, [{ id: tankId, title: tank.title }]);
    mocks.request.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) =>
      path === `harnesses/${tankId}` && !options ? { harness: tank, social: {} } : path === `harnesses/${tankId}` && options?.method === 'DELETE' ? { removed: true } : answer(path, options));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<PublishPage />);
    await screen.findByDisplayValue('TANK 1987');
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish this harness' }));
    expect(mocks.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish this harness' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/hub/yours'));
    expect(mocks.request).toHaveBeenCalledWith(`harnesses/${tankId}`, { method: 'DELETE' });
    confirm.mockRestore();
    window.history.replaceState(null, '', '/');
  });
  it('saves an arriving draft over one of your publications when you choose it', async () => {
    mocks.request.mockImplementation(hub(undefined, [{ id: tankId, title: tank.title }]));
    render(<PublishPage />);
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [bundleFile(project)] } });
    await screen.findByDisplayValue('My orbit');
    fireEvent.change(screen.getByLabelText('Upload HTML output'), { target: { files: [Object.assign(new File(['<h1>v2</h1>'], 'index.html'), { text: async () => '<h1>v2</h1>' })] } });
    await waitFor(() => expect(screen.queryByText(/still the original/)).not.toBeInTheDocument());
    fireEvent.change(await screen.findByLabelText('Publish as'), { target: { value: tankId } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/hub/my-orbit-11111111'));
    // Where a publication came from is not an edit's to change.
    expect(saved(tankId)![1].body).not.toHaveProperty('forkedFrom');
    expect(published()).toHaveLength(0);
  });
  it('translates an arriving draft into English and keeps the original to switch back to', async () => {
    const original = { ...project, title: 'Quỹ đạo của tôi', description: 'Một góc nhìn mới', conversation: [{ role: 'user', text: 'Đổi quỹ đạo.' }, { role: 'tool', text: 'ok' }] };
    mocks.request.mockImplementation(hub({ title: 'My orbit', description: 'A new perspective', conversation: [{ role: 'user', text: 'Change the orbit.' }, { role: 'tool', text: 'ok' }] }));
    render(<PublishPage />);
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [bundleFile(original)] } });
    expect(await screen.findByDisplayValue('My orbit')).toBeInTheDocument();
    expect(translations()).toHaveLength(1);
    expect(translations()[0][1].body).toEqual({ title: original.title, description: original.description, conversation: original.conversation });
    expect(screen.getByText(/Translated into English/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Change the orbit.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show original' }));
    expect(screen.getByDisplayValue('Quỹ đạo của tôi')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Đổi quỹ đạo.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use English' }));
    expect(screen.getByDisplayValue('My orbit')).toBeInTheDocument();
    expect(translations()).toHaveLength(1);
  });
  it('translates only once signed in, says when it failed, and tries again on request', async () => {
    mocks.headers.mockReturnValue({});
    render(<PublishPage />); await act(async () => {});
    fireEvent.change(screen.getByLabelText('Import fork bundle'), { target: { files: [bundleFile({ ...project, title: 'Quỹ đạo' })] } });
    await screen.findByDisplayValue('Quỹ đạo');
    expect(translations()).toHaveLength(0);
    const answer = hub();
    mocks.request.mockImplementation(async (path: string, options?: { body?: unknown }) => {
      if (path === 'translate') throw new Error('The translation failed. Try again.');
      return answer(path, options);
    });
    mocks.headers.mockReturnValue({ Authorization: 'Bearer fixture' }); fireEvent.focus(window);
    expect(await screen.findByText(/Could not translate into English/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Quỹ đạo')).toBeInTheDocument();
    mocks.request.mockImplementation(hub({ title: 'Orbit', description: project.description, conversation: project.conversation }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByDisplayValue('Orbit')).toBeInTheDocument();
    expect(translations()).toHaveLength(2);
  });
  it('never translates what the author types here', async () => {
    render(<PublishPage />); await act(async () => {});
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Trò chơi rắn' } });
    await act(async () => {});
    expect(translations()).toHaveLength(0);
    expect(screen.queryByText(/Translat/)).not.toBeInTheDocument();
  });
  it('still knows a fork\'s original output after a reload or a sign-in', async () => {
    vi.mocked(readDraft).mockResolvedValueOnce({ ...project, originalOutput: project.files[0].content } as never);
    render(<PublishPage />);
    expect(await screen.findByText(/index.html is still the original/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission/ }));
    expect(screen.getByRole('button', { name: 'Publish harness' })).toBeDisabled();
  });
  it('refuses a large file by its size, without reading it', async () => {
    render(<PublishPage />); await act(async () => {});
    const read = vi.fn();
    const model = Object.assign(new File([new Uint8Array(2_400_000)], 'model.glb'), { webkitRelativePath: 'project/model.glb', arrayBuffer: read });
    fireEvent.change(screen.getByLabelText('Choose project folder'), { target: { files: [model] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('model.glb is over 3 MB as sent');
    expect(read).not.toHaveBeenCalled();
  });
});
