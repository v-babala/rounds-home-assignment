import { listingFields, type Snapshot } from '@rounds/shared';
import { Badge } from '../../components/Feedback';
import {
  fieldLabels,
  formatTime,
  pollLabels,
  snapshotLabel,
  summaryLabels,
} from '../../lib/presentation';

export function SnapshotCard({ snapshot }: { snapshot: Snapshot }) {
  const status = snapshotLabel(snapshot);
  const summary = summaryLabels[snapshot.summaryStatus];
  const time = snapshot.fetchedAt ?? snapshot.startedAt;
  const waiting = ['pending', 'processing', 'retry_wait'].includes(snapshot.summaryStatus);
  return (
    <li className={`timeline-item ${snapshot.changed ? 'timeline-item--changed' : ''}`}>
      <span className="timeline-node" aria-hidden="true" />
      <article className="snapshot surface" aria-label={`${status.label}, ${formatTime(time)}`}>
        <header className="snapshot-heading">
          <div>
            <Badge tone={status.tone}>{status.label}</Badge>
            {snapshot.changedFields.length > 0 && (
              <span className="changed-fields">
                {snapshot.changedFields.map((field) => fieldLabels[field]).join(', ')} updated
              </span>
            )}
          </div>
          <time dateTime={time}>
            {snapshot.fetchedAt ? 'Fetched' : 'Started'} {formatTime(time)}
          </time>
        </header>
        {snapshot.pollStatus !== 'success' && (
          <div className={`source-notice source-notice--${status.tone}`}>
            <strong>{pollLabels[snapshot.pollStatus].label}</strong>
            <p>{pollLabels[snapshot.pollStatus].description}</p>
            {snapshot.missingFields.length > 0 && (
              <p>
                Missing or invalid:{' '}
                {snapshot.missingFields.map((field) => fieldLabels[field]).join(', ')}.
              </p>
            )}
          </div>
        )}
        <dl className="listing-fields">
          {listingFields.map((field) => (
            <div
              key={field}
              className={`listing-field listing-field--${field} ${snapshot.changedFields.includes(field) ? 'listing-field--changed' : ''}`}
            >
              <dt>
                {fieldLabels[field]}
                {snapshot.changedFields.includes(field) && (
                  <span className="field-changed">Changed</span>
                )}
              </dt>
              <dd>
                {snapshot[field] ?? <span className="muted">Not available in this poll</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div
          className={`summary-box ${snapshot.summaryStatus === 'ready' ? 'summary-box--ready' : ''}`}
        >
          <div className="summary-heading">
            <span className="summary-spark" aria-hidden="true">
              ✧
            </span>
            <h3>{summary.label}</h3>
            {waiting && <span className="spinner spinner--small" aria-hidden="true" />}
            {snapshot.summaryProvider === 'mock-llm' && (
              <span className="mock-label">Demo model</span>
            )}
          </div>
          <p>
            {snapshot.summaryStatus === 'ready'
              ? (snapshot.summary ?? 'The summary text is unavailable. The snapshot is saved.')
              : snapshot.summaryStatus === 'source_unavailable' && snapshot.pollStatus === 'running'
                ? 'Waiting for the source response before comparing this listing.'
                : summary.description}
          </p>
          {snapshot.summaryStatus === 'ready' && snapshot.summaryProvider === 'mock-llm' && (
            <p className="summary-note">
              Demonstration response from the mock service, not a real AI explanation.
            </p>
          )}
          {snapshot.summaryStatus === 'failed' && snapshot.summaryAttempts > 0 && (
            <p className="summary-note">Attempts made: {snapshot.summaryAttempts}.</p>
          )}
        </div>
      </article>
    </li>
  );
}
