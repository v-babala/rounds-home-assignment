import type { ListingField, PollStatus, Snapshot, SummaryStatus } from '@rounds/shared';

export type Tone = 'neutral' | 'green' | 'amber' | 'red';
export const fieldLabels: Record<ListingField, string> = {
  title: 'Title',
  tagline: 'Tagline',
  price: 'Price',
  description: 'Description',
};
export const pollLabels: Record<PollStatus, { label: string; tone: Tone; description: string }> = {
  running: {
    label: 'Fetching',
    tone: 'neutral',
    description: 'The source request is still running. The result will appear automatically.',
  },
  success: {
    label: 'Up to date',
    tone: 'green',
    description: 'The listing was fetched successfully.',
  },
  not_found: {
    label: 'Not found',
    tone: 'amber',
    description:
      'The source does not list this ID right now. It may be unknown or temporarily unavailable. We will keep checking.',
  },
  rate_limited: {
    label: 'Rate limited',
    tone: 'amber',
    description: 'The source asked us to wait. Polling resumes after its waiting period.',
  },
  timeout: {
    label: 'Timed out',
    tone: 'amber',
    description:
      'The source took too long to respond. This attempt is saved and polling will continue.',
  },
  network_error: {
    label: 'Connection failed',
    tone: 'red',
    description:
      'The source could not be reached. This attempt is saved and polling will continue.',
  },
  http_error: {
    label: 'Source error',
    tone: 'red',
    description: 'The source returned an error. This attempt is saved and polling will continue.',
  },
  invalid_response: {
    label: 'Invalid response',
    tone: 'amber',
    description:
      'The source returned an unusable response. The last complete listing remains the comparison baseline.',
  },
  incomplete: {
    label: 'Incomplete listing',
    tone: 'amber',
    description:
      'Some listing fields are missing or invalid. Available fields are shown below; this response does not replace the last complete listing.',
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'amber',
    description: 'The request was interrupted before completion. A new poll is scheduled.',
  },
};

export const summaryLabels: Record<SummaryStatus, { label: string; description: string }> = {
  baseline: {
    label: 'First snapshot',
    description: 'This is the first complete listing. Future snapshots will be compared with it.',
  },
  unchanged: {
    label: 'No meaningful changes',
    description: 'The listing matches the last complete snapshot. No AI summary is needed.',
  },
  source_unavailable: {
    label: 'Summary unavailable',
    description: 'A complete listing is needed to compare changes and generate a summary.',
  },
  pending: {
    label: 'Summary queued',
    description: 'A change was detected. The AI summary is waiting to be generated.',
  },
  processing: {
    label: 'Writing summary',
    description: 'The AI summary is being generated. This page updates automatically.',
  },
  retry_wait: {
    label: 'Summary will retry',
    description:
      'The summary service encountered a temporary problem. Another attempt is scheduled; your snapshot is saved.',
  },
  failed: {
    label: 'Summary failed',
    description:
      'The summary could not be generated. The snapshot and its changed fields are saved.',
  },
  budget_exhausted: {
    label: 'Daily AI limit reached',
    description:
      'The daily summary allowance has been used. This snapshot is saved, but its summary will not be generated later.',
  },
  ready: { label: 'Change summary', description: '' },
};

export function snapshotLabel(snapshot: Snapshot): { label: string; tone: Tone } {
  if (snapshot.pollStatus !== 'success') return pollLabels[snapshot.pollStatus];
  if (snapshot.comparisonStatus === 'changed') return { label: 'Changed', tone: 'green' };
  if (snapshot.comparisonStatus === 'baseline') return { label: 'First snapshot', tone: 'neutral' };
  if (snapshot.comparisonStatus === 'unavailable')
    return { label: 'Comparison unavailable', tone: 'amber' };
  return { label: 'No changes', tone: 'neutral' };
}

const timestampFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});
export function formatTime(value: string): string {
  return timestampFormatter.format(new Date(value));
}
export function timelineUrl(id: string): string {
  return `#/competitors/${encodeURIComponent(id)}`;
}
