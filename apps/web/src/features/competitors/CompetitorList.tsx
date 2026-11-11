import { useRef, useState } from 'react';
import { useCompetitors } from '../../lib/queries';
import { formatTime, pollLabels, timelineUrl } from '../../lib/presentation';
import { Badge, EmptyState, ErrorNotice, LoadingState } from '../../components/Feedback';
import { Icon } from '../../components/Icon';
import { AddCompetitor } from './AddCompetitor';
import { RemoveCompetitor } from './RemoveCompetitor';

const PAGE_SIZE = 50;

export function CompetitorList() {
  const query = useCompetitors();
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const competitors = query.data ?? [];
  const filtered = competitors.filter((item) =>
    item.id.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Refetches and removals can shrink the last page.
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const changed = competitors.filter((item) => item.changedInLast24h).length;
  const attention = competitors.filter(
    (item) => item.lastPollStatus && !['success', 'running'].includes(item.lastPollStatus),
  ).length;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR MARKET, IN FOCUS</p>
          <h1 ref={heading} tabIndex={-1}>
            Competitors
          </h1>
          <p className="page-description">Follow the changes that matter. Keep the full picture.</p>
        </div>
        <span className="live-label">
          <span className="status-dot" />
          Auto-refreshes every 10 seconds
        </span>
      </div>
      <div className="stat-grid" aria-label="Watchlist overview">
        <div className="stat">
          <span>Tracked competitors</span>
          <strong>{query.data ? competitors.length : '—'}</strong>
          <small>Your active watchlist</small>
        </div>
        <div className="stat stat--accent">
          <span>Changed in 24 hours</span>
          <strong>{query.data ? changed : '—'}</strong>
          <small>Meaningful listing changes</small>
        </div>
        <div className="stat">
          <span>Need attention</span>
          <strong>{query.data ? attention : '—'}</strong>
          <small>Latest poll was unsuccessful</small>
        </div>
      </div>
      <AddCompetitor />
      <section className="surface watchlist" aria-labelledby="watchlist-heading">
        <div className="section-heading">
          <div>
            <h2 id="watchlist-heading">
              Your watchlist <span className="count-label">{competitors.length}</span>
            </h2>
            <p>Open a competitor to explore its complete history.</p>
          </div>
          <button
            className="button button--ghost button--small"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <Icon name="refresh" />
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {notice && (
          <p className="inline-notice" role="status">
            {notice}
          </p>
        )}
        {query.error && <ErrorNotice error={query.error} retry={() => void query.refetch()} />}
        <div className="watchlist-controls">
          <label htmlFor="competitor-search">Search competitors</label>
          <input
            id="competitor-search"
            type="search"
            value={search}
            placeholder="Search by ID"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        {query.isPending ? (
          <LoadingState label="Loading your watchlist…" />
        ) : query.data?.length === 0 ? (
          <EmptyState title="A little competitive intelligence starts here">
            Add a competitor above. We’ll keep its listing history and highlight meaningful changes.
          </EmptyState>
        ) : query.data && filtered.length === 0 ? (
          <EmptyState title="No competitors match your search">
            Try a different ID or clear the search.
          </EmptyState>
        ) : (
          query.data && (
            <div className="table-scroll">
              <table>
                <caption className="sr-only">
                  Tracked competitors and their latest polling status
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Competitor</th>
                    <th scope="col">Last 24 hours</th>
                    <th scope="col">Latest poll</th>
                    <th scope="col">Fetched at</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <a className="competitor-link" href={timelineUrl(item.id)}>
                          <span className="avatar" aria-hidden="true">
                            {item.id.slice(0, 2).toUpperCase()}
                          </span>
                          <span>
                            {item.id}
                            <span className="row-sublabel">
                              View timeline <Icon name="arrow" />
                            </span>
                          </span>
                        </a>
                      </th>
                      <td>
                        {item.changedInLast24h ? (
                          <Badge tone="green">Changed</Badge>
                        ) : (
                          <span className="muted">No changes detected</span>
                        )}
                      </td>
                      <td>
                        {item.lastPollStatus ? (
                          <Badge tone={pollLabels[item.lastPollStatus].tone}>
                            {pollLabels[item.lastPollStatus].label}
                          </Badge>
                        ) : (
                          <Badge>Awaiting first poll</Badge>
                        )}
                      </td>
                      <td className="time-cell">
                        {item.lastPolledAt ? (
                          <time dateTime={item.lastPolledAt}>{formatTime(item.lastPolledAt)}</time>
                        ) : (
                          <span className="muted">Not fetched yet</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`Stop tracking ${item.id}`}
                          title="Stop tracking"
                          onClick={() => {
                            setNotice('');
                            setRemoving(item.id);
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {query.data && filtered.length > 0 && (
          <nav className="watchlist-pagination" aria-label="Watchlist pages">
            <button
              className="button button--ghost button--small"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous page
            </button>
            <span role="status">
              Page {currentPage + 1} of {pageCount} · {filtered.length} matching competitors
            </span>
            <button
              className="button button--ghost button--small"
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next page
            </button>
          </nav>
        )}
        <div className="section-footer">
          Listing changes are detected independently of AI summaries.{' '}
          <span>Times shown in your local timezone.</span>
        </div>
      </section>
      {removing && (
        <RemoveCompetitor
          key={removing}
          id={removing}
          close={() => setRemoving(null)}
          removed={(id) => {
            setNotice(`${id} is no longer tracked. Its history is saved.`);
            heading.current?.focus();
          }}
        />
      )}
    </>
  );
}
