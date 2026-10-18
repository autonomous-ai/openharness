import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilesReview } from './FilesReview';

describe('files under review', () => {
  it('draws a file’s text only once it is opened, and sizes each as it is sent', async () => {
    const files = [
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: 'app.js', content: 'x'.repeat(2048) },
      { path: 'cover.png', content: 'iVBORw0KGgo=', encoding: 'base64' as const },
    ];
    render(<FilesReview files={files} viewerPath="index.html" onRemove={vi.fn()} onViewer={vi.fn()} />);
    expect(screen.queryByText('<h1>Hi</h1>')).not.toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('12 B')).toBeInTheDocument();
    fireEvent.click(screen.getByText('index.html', { selector: 'summary' }));
    expect(await screen.findByText('<h1>Hi</h1>')).toBeInTheDocument();
  });
});
