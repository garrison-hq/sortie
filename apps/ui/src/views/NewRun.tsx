import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { createQuery, createRun, listProfiles } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { ProfileInfo, RunKind, RunSpec } from '../types';
import { isSlug, messageOf } from '../util';

const DEFAULT_MAX_STEPS = 25;

interface Preset {
  label: string;
  kind: RunKind;
  url: string;
  instruction?: string;
  goal?: string;
  schema: Record<string, unknown>;
}

const PRESETS: Preset[] = [
  {
    label: 'book list',
    kind: 'extract',
    url: 'https://books.toscrape.com',
    instruction: 'the list of books on the page',
    schema: {
      type: 'object',
      properties: {
        books: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              price: { type: 'number' },
            },
            required: ['title', 'price'],
          },
        },
      },
      required: ['books'],
    },
  },
  {
    label: 'login demo',
    kind: 'agent',
    url: 'https://the-internet.herokuapp.com/login',
    goal: 'Log in with username tomsmith and password SuperSecretPassword!, then report whether the login succeeded and the flash message shown.',
    schema: {
      type: 'object',
      properties: {
        loggedIn: { type: 'boolean' },
        message: { type: 'string' },
      },
      required: ['loggedIn', 'message'],
    },
  },
];

type SchemaState =
  | { kind: 'empty' }
  | { kind: 'valid'; value: Record<string, unknown> }
  | { kind: 'invalid'; error: string };

function parseSchemaText(text: string): SchemaState {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { kind: 'invalid', error: messageOf(err) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', error: 'schema must be a JSON object' };
  }
  return { kind: 'valid', value: parsed as Record<string, unknown> };
}

export function NewRun() {
  const [kind, setKind] = useState<RunKind>('extract');
  const [url, setUrl] = useState('');
  const [instruction, setInstruction] = useState('');
  const [goal, setGoal] = useState('');
  const [schemaText, setSchemaText] = useState('');
  const [maxStepsText, setMaxStepsText] = useState(String(DEFAULT_MAX_STEPS));
  const [maxCharsText, setMaxCharsText] = useState('');
  const [credsText, setCredsText] = useState('');
  const [profile, setProfile] = useState('');
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [savedQueryName, setSavedQueryName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Login profiles are best-effort decoration — an older server without the
  // endpoint just leaves the dropdown empty.
  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const schemaState = useMemo(() => parseSchemaText(schemaText), [schemaText]);

  const maxSteps = Number(maxStepsText);
  const maxStepsValid = Number.isInteger(maxSteps) && maxSteps > 0;
  const maxChars = Number(maxCharsText);
  const maxCharsValid = maxCharsText.trim() === '' || (Number.isInteger(maxChars) && maxChars > 0);

  const canSubmit =
    !submitting &&
    url.trim() !== '' &&
    schemaState.kind !== 'invalid' &&
    (kind === 'extract'
      ? schemaState.kind === 'valid' // extract requires an output schema
      : kind === 'agent'
        ? goal.trim() !== '' && maxStepsValid
        : maxCharsValid); // fetch only needs a URL (and a sane optional cap)

  function applyPreset(preset: Preset): void {
    setKind(preset.kind);
    setUrl(preset.url);
    setInstruction(preset.instruction ?? '');
    setGoal(preset.goal ?? '');
    setSchemaText(JSON.stringify(preset.schema, null, 2));
    setMaxStepsText(String(DEFAULT_MAX_STEPS));
    setCredsText('');
    setError(null);
  }

  /** The spec the form currently describes (shared by submit + save-as-query). */
  function buildSpec(): RunSpec {
    const spec: RunSpec = { kind, url: url.trim() };
    if (kind !== 'fetch' && schemaState.kind === 'valid') spec.schemaJson = schemaState.value;
    if (kind === 'extract') {
      const hint = instruction.trim();
      if (hint !== '') spec.instruction = hint;
    } else if (kind === 'agent') {
      spec.goal = goal.trim();
      spec.maxSteps = maxSteps;
      const names = credsText
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
      if (names.length > 0) spec.credentialNames = names;
    } else if (maxCharsText.trim() !== '' && maxCharsValid) {
      spec.maxChars = maxChars;
    }
    if (profile !== '') spec.profile = profile;
    return spec;
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const record = await createRun(buildSpec());
      window.location.hash = `#/runs/${record.id}`;
    } catch (err) {
      setError(messageOf(err));
      setSubmitting(false);
    }
  }

  async function saveAsQuery(): Promise<void> {
    const name = window.prompt(
      'Query name (lowercase letters, digits, "-" and "_"):',
      savedQueryName ?? '',
    );
    if (name === null || name === '') return;
    if (!isSlug(name)) {
      setError(`"${name}" is not a valid query name (lowercase slug, max 64 chars).`);
      return;
    }
    setError(null);
    try {
      const query = await createQuery(name, buildSpec());
      setSavedQueryName(query.name);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const schemaIndicator =
    schemaState.kind === 'valid' ? (
      <span className="json-indicator valid">✓ valid JSON</span>
    ) : schemaState.kind === 'invalid' ? (
      <span className="json-indicator invalid">✗ {schemaState.error}</span>
    ) : kind === 'extract' ? (
      <span className="json-indicator invalid">required for extract</span>
    ) : (
      <span className="json-indicator empty">empty — agent output will be free-form</span>
    );

  // Save-as-query needs the same validity as submitting an extract run.
  const canSaveQuery = kind === 'extract' && url.trim() !== '' && schemaState.kind === 'valid';

  return (
    <div>
      <h1 className="page-title">New run</h1>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <span className="field-label">Kind</span>
          <div className="segmented" role="group" aria-label="Run kind">
            <button
              type="button"
              className={kind === 'extract' ? 'active' : ''}
              onClick={() => setKind('extract')}
            >
              extract
            </button>
            <button
              type="button"
              className={kind === 'agent' ? 'active' : ''}
              onClick={() => setKind('agent')}
            >
              agent
            </button>
            <button
              type="button"
              className={kind === 'fetch' ? 'active' : ''}
              onClick={() => setKind('fetch')}
            >
              fetch
            </button>
          </div>
        </div>

        <label className="field">
          <span className="field-label">{kind === 'agent' ? 'Start URL' : 'URL'}</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            required
          />
        </label>

        {kind === 'extract' ? (
          <label className="field">
            <span className="field-label">
              Instruction <span className="hint">optional hint about what to extract</span>
            </span>
            <input
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="the list of books on the page"
            />
          </label>
        ) : kind === 'agent' ? (
          <label className="field">
            <span className="field-label">Goal</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total"
            />
          </label>
        ) : (
          <label className="field">
            <span className="field-label">
              Max characters <span className="hint">optional cap on the returned markdown</span>
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={maxCharsText}
              onChange={(e) => setMaxCharsText(e.target.value)}
              placeholder="40000"
            />
          </label>
        )}

        {kind !== 'fetch' && (
          <label className="field">
            <span className="field-label">
              Output schema (JSON Schema)
              {schemaIndicator}
              <span className="spacer" />
            </span>
            <textarea
              className="mono"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              placeholder='{"type":"object","properties":{...},"required":[...]}'
              spellCheck={false}
            />
          </label>
        )}

        <div className="btn-group">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="btn btn-small"
              onClick={() => applyPreset(preset)}
            >
              preset: {preset.label}
            </button>
          ))}
        </div>

        {kind === 'agent' && (
          <div className="field-row">
            <label className="field">
              <span className="field-label">Max steps</span>
              <input
                type="number"
                min={1}
                step={1}
                value={maxStepsText}
                onChange={(e) => setMaxStepsText(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">
                Credential env vars{' '}
                <span className="hint">comma-separated NAMES, never values</span>
              </span>
              <input
                type="text"
                value={credsText}
                onChange={(e) => setCredsText(e.target.value)}
                placeholder="SAUCE_PASSWORD, OTHER_SECRET"
                spellCheck={false}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span className="field-label">
            Login profile{' '}
            <span className="hint">
              reuse a saved session — create profiles with <code>nanofish profile login</code>
            </span>
          </span>
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">(none)</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.domainHint !== undefined ? ` — ${p.domainHint}` : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="btn-group">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {submitting ? 'Submitting…' : 'Start run'}
          </button>
          {kind === 'extract' && (
            <button
              type="button"
              className="btn"
              disabled={!canSaveQuery}
              title={canSaveQuery ? undefined : 'Needs a URL and a valid output schema'}
              onClick={() => void saveAsQuery()}
            >
              Save as query
            </button>
          )}
          {savedQueryName !== null && (
            <span className="hint">
              saved as <a href="#/queries">{savedQueryName}</a> ✓
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
