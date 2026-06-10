# Security policy

sortie is pre-1.0 software built by a solo maintainer. This file
documents what security reporting looks like in practice given that
constraint, so expectations are honest up front.

---

## Supported versions

Only the current `main` branch is actively maintained. There are no
backported security fixes. If you are running anything older, the first
step of any security discussion will be "please upgrade."

| Version        | Supported |
| -------------- | --------- |
| `main`         | Yes       |
| Anything older | No        |

---

## Reporting a vulnerability

**Do not open a public GitHub issue for a security-sensitive bug.**

Report privately via the repository's **Security → Report a
vulnerability** flow (GitHub private advisory), which routes to the
maintainer's private inbox.

Please include:

- A description of the issue and where in the code you believe it lives
  (file path + line number if you have one).
- The conditions under which it is exploitable (e.g. "requires the
  server to be reachable by the attacker" — note the API is documented
  as trusted-network-only).
- A minimal reproduction if you have one.
- Whether you have disclosed this anywhere else and on what timeline
  you expect to disclose publicly.

**Response expectations:** acknowledgement within **7 calendar days**;
triage with rough severity and fix timeline within another **7 days**;
most fixes within **30 days** of acknowledgement. Disclosure is
coordinated by default, with credit to the reporter unless anonymity is
requested. If 90 days pass without a fix, you are free to disclose —
please give notice first.

---

## What counts as a vulnerability

The interesting attack surfaces, in rough priority order:

1. **Credential scrubbing bypass.** The `{{cred:NAME}}` model promises
   that credential _values_ never reach the LLM, run traces, logs, or
   the database — substitution happens at type-time and observations
   are scrubbed. Any path that leaks a raw value to the model or to
   persisted state is a vulnerability, full stop.
2. **Login-profile exposure.** Profile storage states (cookies +
   localStorage) are written with `0600` permissions and the API is
   deliberately write-only for them (`/api/profiles/import` accepts,
   nothing returns session material). Any read path that exposes
   session cookies is a vulnerability.
3. **Path traversal / file disclosure** in the server (e.g. the
   screenshot and export endpoints serving files derived from
   user-supplied identifiers).
4. **Injection** — SQL injection in the SQLite store, command
   injection, or prototype-pollution-style issues in schema handling.
5. **Prompt injection with security consequences.** Web content
   steering the agent is a known, inherent risk of the design — but a
   demonstrated chain from page-controlled content to _credential
   exfiltration or local file access_ qualifies as a vulnerability.

Examples that do **not** qualify and should go in a normal issue:

- "The REST API has no authentication." Documented and by design —
  the server is for trusted networks only (localhost, VPN, or behind
  your own authenticating reverse proxy). Don't expose it publicly.
- "An agent can be told to browse somewhere unintended." Inherent to
  instruction-following agents; mitigations are welcome as features.
- "sortie can be pointed at a site that forbids scraping." Operator
  responsibility; see the scope boundaries in the README.
- Resource exhaustion that requires the operator's own configuration
  choices.

Reports asking for CAPTCHA bypass or anti-bot evasion are out of scope
for the project entirely and will be closed.

---

## Scope

This policy covers the code in this repository (`packages/core`,
`apps/server`, `apps/ui`, `apps/mcp`). It does not cover upstream
dependencies (report to their maintainers), your deployment
infrastructure, or downstream forks.
