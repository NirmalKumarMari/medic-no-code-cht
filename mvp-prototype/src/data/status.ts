// Plain-language status for a change, and its colour group. The words always
// carry the meaning, so colour is never the only signal.

export type StatusTone = 'success' | 'attention' | 'danger' | 'neutral';

const STATUSES: Record<string, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  draft_failed: { label: 'Draft failed', tone: 'danger' },
  checked: { label: 'Checked', tone: 'neutral' },
  content_review: { label: 'Needs review', tone: 'attention' },
  content_approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Sent back', tone: 'danger' },
  build_failed: { label: 'Build failed', tone: 'danger' },
  built: { label: 'Built', tone: 'neutral' },
  test_failed: { label: 'Tests failed', tone: 'danger' },
  tested: { label: 'Tested', tone: 'success' },
  deploy_review: { label: 'Needs IT approval', tone: 'attention' },
  deploy_approved: { label: 'Ready to deploy', tone: 'success' },
  deploying: { label: 'Deploying', tone: 'neutral' },
  // The run ends with a CHT project to install; nothing is pushed to a CHT server.
  deployed: { label: 'Ready to install', tone: 'success' },
  drafting: { label: 'Drafting', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'danger' },
};

/** A run's status, including the time before its first version exists and after it stops. */
export function runState(status: string, state?: string): string {
  if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'ABORTED')
    return state?.endsWith('_failed') ? state : 'stopped';
  return state ?? 'drafting';
}

export function plainWords(value: string): string {
  const words = value.replace(/[-._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function statusLabel(state: string): string {
  return STATUSES[state]?.label ?? plainWords(state);
}

export function statusTone(state: string): StatusTone {
  return STATUSES[state]?.tone ?? 'neutral';
}
