import type { RunStatus } from '../types';

/** Color-coded pill for a run status. Colors live in styles.css (.chip-*). */
export function StatusChip({ status }: { status: RunStatus }) {
  return <span className={`chip chip-${status}`}>{status}</span>;
}
