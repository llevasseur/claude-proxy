import type { CostUnavailableReason, TodaySummary } from '@codex-proxy/core';
import { Link, Outlet } from '@tanstack/react-router';
import { Gauge, Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HealthResponse } from './api.ts';
import { type StreamState, useLiveOverview } from './use-live-overview.ts';

type Theme = 'dark' | 'light';
type SystemState =
  | 'loading'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stale'
  | 'degraded'
  | 'offline'
  | 'unavailable';

const STATUS_COPY: Record<SystemState, { label: string; detail: string; tone: 'ok' | 'warn' | 'bad' }> = {
  loading: { label: 'Loading', detail: 'Reading the local usage service.', tone: 'warn' },
  connecting: { label: 'Connecting', detail: 'Opening the live update stream.', tone: 'warn' },
  live: { label: 'Live', detail: 'Usage updates arrive without a refresh.', tone: 'ok' },
  reconnecting: {
    label: 'Reconnecting',
    detail: 'Showing the last known totals while the stream retries.',
    tone: 'warn',
  },
  stale: { label: 'Stale', detail: 'The last known totals are visible; a backstop refresh is retrying.', tone: 'warn' },
  degraded: { label: 'Degraded', detail: 'The API is available, but the proxy is not ready.', tone: 'warn' },
  offline: { label: 'Offline', detail: 'No live connection or local summary is available.', tone: 'bad' },
  unavailable: { label: 'Unavailable', detail: 'The local proxy status is unavailable.', tone: 'bad' },
};

function initialTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('admin:theme', next);
    } catch {
      // The theme still applies for this page when storage is unavailable.
    }
    setTheme(next);
  };
  return [theme, toggle] as const;
}

function Brand({ className = 'brand-link', onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <Link to="/" className={className} aria-label="codex proxy — Overview" onClick={onNavigate}>
      <span className="brand-node" aria-hidden />
      <span className="brand">
        codex<span className="brand-sep"> / </span>proxy
      </span>
    </Link>
  );
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const railLabel = railCollapsed ? 'Expand navigation' : 'Collapse navigation';
  const themeLabel = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';

  return (
    <div className={`app${railCollapsed ? ' app--rail-collapsed' : ''}${drawerOpen ? ' app--drawer-open' : ''}`}>
      <aside className="rail" id="rail-nav">
        <div className="rail-head">
          <button
            type="button"
            className="rail-toggle"
            onClick={() => setRailCollapsed((value) => !value)}
            aria-pressed={railCollapsed}
            aria-label={railLabel}
            title={railLabel}
          >
            {railCollapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          </button>
          <Brand className="brand-link topbar-brand" onNavigate={() => setDrawerOpen(false)} />
        </div>

        <nav className="stations" aria-label="Primary">
          <div className="nav-group">
            <h2 className="nav-group-label" id="nav-group-dashboard">
              Dashboard
            </h2>
            <Link
              to="/"
              className="station"
              activeProps={{ className: 'station active' }}
              activeOptions={{ exact: true }}
              onClick={() => setDrawerOpen(false)}
            >
              <Gauge className="station-icon" size={17} strokeWidth={1.75} aria-hidden />
              <span className="station-label">Overview</span>
              <span className="station-hint">today</span>
            </Link>
          </div>
        </nav>

        <div className="rail-foot">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme === 'light' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}
          </button>
          <span className="rail-foot-label">local only</span>
        </div>
      </aside>

      {drawerOpen && (
        <button
          type="button"
          className="rail-scrim"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div className="workspace">
        <div className="topbar">
          <button
            type="button"
            className="drawer-toggle"
            onClick={() => setDrawerOpen((value) => !value)}
            aria-expanded={drawerOpen}
            aria-controls="rail-nav"
            aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
            title={drawerOpen ? 'Close navigation' : 'Open navigation'}
          >
            <Menu size={20} aria-hidden />
          </button>
          <Brand onNavigate={() => setDrawerOpen(false)} />
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function systemState(
  stream: StreamState,
  health: HealthResponse | undefined,
  hasSummary: boolean,
  queryFailed: boolean,
): SystemState {
  if (!health && !hasSummary && queryFailed) return stream === 'offline' ? 'offline' : 'unavailable';
  if (!health && !hasSummary) return 'loading';
  if (stream === 'offline') return 'offline';
  if (stream === 'reconnecting') return 'reconnecting';
  if (queryFailed) return 'stale';
  if (health?.proxy.status === 'unavailable') return 'unavailable';
  if (health?.proxy.status === 'degraded' || health?.ready === false) return 'degraded';
  if (stream === 'connecting') return 'connecting';
  return 'live';
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat().format(value);
}

function formatCost(summary: TodaySummary | undefined): string {
  if (!summary?.cost) return summary ? 'Unavailable' : '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: summary.cost.currency,
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(Number(summary.cost.amountUsd));
}

function unavailableReason(reason: CostUnavailableReason | null | undefined): string {
  if (!reason) return 'Cost data has not loaded.';
  if (reason.code === 'unknown-model') return `Unknown model: ${reason.model}`;
  if (reason.code === 'missing-category-price') return `Missing ${reason.category} price for ${reason.model}.`;
  return `Incomplete aggregate: ${reason.detail}.`;
}

function StatCard({
  label,
  value,
  detail,
  unavailable = false,
}: {
  label: string;
  value: string;
  detail: string;
  unavailable?: boolean;
}) {
  return (
    <article className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${unavailable ? ' stat-value--unavailable' : ''}`}>{value}</div>
      <div className="stat-foot">
        <span className="muted">{detail}</span>
      </div>
    </article>
  );
}

export function OverviewPage() {
  const { health, summary, stream, lastEventAt } = useLiveOverview();
  const data = summary.data;
  const state = systemState(stream, health.data, data !== undefined, health.isError || summary.isError);
  const status = STATUS_COPY[state];
  const isEmpty = data?.requestCount === 0;
  const latest = data?.latestEventTimestamp
    ? `Latest request ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.latestEventTimestamp))}`
    : 'No traffic yet';
  const costMissing = data !== undefined && data.cost === null;

  return (
    <section className="overview-page" aria-labelledby="overview-title">
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id="overview-title">Overview</h1>
          <div className="muted">Today · {data?.reportTimezone ?? 'report timezone loading'}</div>
        </div>
        <div className={`health live-status live-status--${state}`} role="status" aria-live="polite">
          <span className={`dot ${status.tone}`} aria-hidden />
          <span>
            <strong>{status.label}</strong>
            <span className="health-text"> · {status.detail}</span>
          </span>
        </div>
      </header>

      {(health.isError || summary.isError) && data === undefined && (
        <div className="card notice notice--error" role="alert">
          The local API could not be reached. The page shell will stay available while it retries.
        </div>
      )}

      <div className="grid stats" aria-busy={data === undefined}>
        <StatCard
          label="Input tokens"
          value={formatCount(data?.inputTokens)}
          detail={data ? latest : 'Loading today’s total'}
        />
        <StatCard
          label="Output tokens"
          value={formatCount(data?.outputTokens)}
          detail={data ? latest : 'Loading today’s total'}
        />
        <StatCard
          label="Cost"
          value={formatCost(data)}
          unavailable={costMissing}
          detail={
            costMissing
              ? unavailableReason(data.costUnavailableReason)
              : data
                ? `${data.requestCount.toLocaleString()} requests · ${data.cost?.currency ?? ''}`
                : 'Loading today’s total'
          }
        />
      </div>

      {isEmpty && (
        <div className="card empty overview-empty">
          <strong>No traffic yet.</strong>
          <span>Send a request through codex-proxy and these cards will update live.</span>
        </div>
      )}

      <footer className="overview-meta muted">
        <span>
          Database: {health.data ? `${health.data.database.recordCount.toLocaleString()} records` : 'loading'}
        </span>
        <span>Live event: {lastEventAt ? new Date(lastEventAt).toLocaleTimeString() : 'waiting'}</span>
      </footer>
    </section>
  );
}
