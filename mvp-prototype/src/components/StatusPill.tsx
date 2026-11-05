import { statusLabel, statusTone } from '../data/status';

export default function StatusPill({ state }: { state: string }) {
  return <span className={`pill pill-${statusTone(state)}`}>{statusLabel(state)}</span>;
}
