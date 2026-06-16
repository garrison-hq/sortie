import type { StepRecord } from '../types';
import { formatDuration, truncate } from '../util';

const INPUT_PREVIEW_CHARS = 120;
const OBSERVATION_PREVIEW_CHARS = 200;

/** One timeline entry: index, tool badge, compact input, observation, thought. */
export function StepItem({ step }: { step: StepRecord }) {
  const input = truncate(JSON.stringify(step.action.input), INPUT_PREVIEW_CHARS);
  const observation = truncate(
    step.observation.replaceAll(/\s+/g, ' ').trim(),
    OBSERVATION_PREVIEW_CHARS,
  );
  return (
    <div className="step">
      <div className="step-head">
        {/* StepRecord.index is 0-based; display 1-based for humans. */}
        <span className="step-index mono">#{step.index + 1}</span>
        <span className="tool-badge">{step.action.tool}</span>
        <span className="step-input mono" title={JSON.stringify(step.action.input)}>
          {input}
        </span>
        <span className="step-duration">{formatDuration(step.durationMs)}</span>
      </div>
      {observation !== '' && <div className="step-observation">{observation}</div>}
      {step.thought !== '' && (
        <details className="step-thought">
          <summary>thought</summary>
          <div className="step-thought-body">{step.thought}</div>
        </details>
      )}
    </div>
  );
}
