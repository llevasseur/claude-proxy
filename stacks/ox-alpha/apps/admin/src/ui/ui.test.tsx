// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BarChart } from './BarChart';
import { Breadcrumbs } from './Breadcrumbs';
import { MarkdownText } from './Markdown';
import { QueryState } from './QueryState';

afterEach(cleanup);

describe('QueryState', () => {
  it('renders loading, error, and empty states with stable test hooks', () => {
    const { rerender } = render(
      <QueryState loading error={false} empty={false} testIdPrefix='demo' emptyText='nothing here'>
        <p>content</p>
      </QueryState>,
    );
    expect(screen.getByTestId('demo-loading').textContent).toContain('Loading');
    expect(screen.queryByText('content')).toBeNull();

    rerender(
      <QueryState loading={false} error empty={false} testIdPrefix='demo' emptyText='nothing here'>
        <p>content</p>
      </QueryState>,
    );
    expect(screen.getByTestId('demo-error').getAttribute('role')).toBe('alert');

    rerender(
      <QueryState loading={false} error={false} empty testIdPrefix='demo' emptyText='nothing here'>
        <p>content</p>
      </QueryState>,
    );
    expect(screen.getByTestId('demo-empty').textContent).toContain('nothing here');

    rerender(
      <QueryState loading={false} error={false} empty={false} testIdPrefix='demo' emptyText='x'>
        <p>content</p>
      </QueryState>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });
});

describe('BarChart', () => {
  it('draws one bar per datum with the maximum scaled to the plot', () => {
    render(
      <BarChart
        testId='chart'
        data={[
          { label: '2026-08-19', value: 50 },
          { label: '2026-08-20', value: 100 },
          { label: '2026-08-21', value: 0 },
        ]}
      />,
    );
    const chart = screen.getByTestId('chart');
    const bars = chart.querySelectorAll('rect');
    expect(bars).toHaveLength(3);
    // The zero day still shows a visible stub rather than vanishing.
    expect(Number(bars[2]?.getAttribute('height'))).toBeGreaterThan(0);
    expect(chart.querySelector('figcaption')?.textContent).toContain('highest 100');
  });

  it('renders nothing for an empty series', () => {
    render(<BarChart data={[]} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('MarkdownText', () => {
  it('splits paragraphs, inline code, and fenced blocks without injecting HTML', () => {
    render(<MarkdownText text={'first paragraph\n\nsecond with `code` span\n```\nconst x = 1;\n```'} />);
    const root = screen.getByTestId('markdown-text');
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.querySelector('.inline-code')?.textContent).toBe('code');
    const block = screen.getByTestId('code-block');
    expect(block.textContent).toContain('const x = 1;');
    expect(root.innerHTML.includes('<script')).toBe(false);
  });

  it('keeps unmatched backticks literal', () => {
    render(<MarkdownText text={'a ` b'} />);
    expect(screen.getByTestId('markdown-text').textContent).toBe('a ` b');
  });
});

describe('Breadcrumbs', () => {
  it('links ancestors and marks the current page', () => {
    render(
      <Breadcrumbs
        crumbs={[
          { label: 'Context', href: '#/boat' },
          { label: 'Sessions', href: '#/boat/sessions' },
          { label: 'sess-1' },
        ]}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toContain('#/boat');
    expect(screen.getByText('sess-1').getAttribute('aria-current')).toBe('page');
  });
});
