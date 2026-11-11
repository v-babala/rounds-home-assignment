import { useTimeline } from '../../lib/queries';
import { Badge, EmptyState, ErrorNotice, LoadingState } from '../../components/Feedback';
import { Icon } from '../../components/Icon';
import { SnapshotCard } from './SnapshotCard';

export function CompetitorTimeline({ id }: { id: string }) {
  const history = useTimeline(id);
  const autoRefreshPaused = (history.data?.pages.length ?? 0) > 1;
  const tracked = history.data?.pages[0]?.active;
  const snapshots = [
    ...new Map(
      history.data?.pages
        .flatMap((page) => page.snapshots)
        .map((snapshot) => [snapshot.id, snapshot]),
    ).values(),
  ];
  return (
    <>
      <a className="back-link" href="#/">
        <Icon name="back" />
        All competitors
      </a>
      <div className="page-heading timeline-title">
        <div>
          <p className="eyebrow">COMPETITOR TIMELINE</p>
          <h1>{id}</h1>
          <p className="page-description">
            Every poll, every change. A complete record of this listing.
          </p>
        </div>
        <div className="timeline-tools">
          {tracked !== undefined && (
            <Badge tone={tracked ? 'green' : 'neutral'}>
              {tracked ? 'Tracking active' : 'Tracking stopped'}
            </Badge>
          )}
          <button
            className="button button--ghost"
            disabled={history.isFetching}
            onClick={() => void history.refetch()}
          >
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
      </div>
      <div className="timeline-context">
        <span>
          <span className="status-dot" />
          Newest first ·{' '}
          {autoRefreshPaused
            ? 'Auto-refresh paused while browsing history · Use Refresh for updates'
            : 'Updates every 10 seconds'}
        </span>
        <span>Times shown in your local timezone</span>
      </div>
      {history.error && !history.isFetchNextPageError && (
        <ErrorNotice error={history.error} retry={() => void history.refetch()} />
      )}
      {history.isPending ? (
        <LoadingState label="Loading listing history…" />
      ) : history.data && snapshots.length === 0 ? (
        <div className="surface">
          <EmptyState title="The story starts with the first poll">
            {tracked === false
              ? 'Tracking is stopped and no snapshots have been saved. Add this ID to your watchlist to resume polling.'
              : 'This competitor is queued for polling. Its first result will appear here automatically, including any source errors.'}
          </EmptyState>
        </div>
      ) : (
        <ol className="timeline">
          {snapshots.map((snapshot) => (
            <SnapshotCard key={snapshot.id} snapshot={snapshot} />
          ))}
        </ol>
      )}
      {history.isFetchNextPageError && history.error && (
        <ErrorNotice error={history.error} retry={() => void history.fetchNextPage()} />
      )}
      {history.hasNextPage && (
        <div className="load-more">
          <button
            className="button button--ghost"
            disabled={history.isFetching}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Loading older snapshots…' : 'Load older snapshots'}
          </button>
          <p>{snapshots.length} snapshots loaded</p>
        </div>
      )}
      {snapshots.length > 0 && !history.hasNextPage && (
        <p className="history-end">You’ve reached the beginning of the available history.</p>
      )}
    </>
  );
}
