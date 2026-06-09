# Project: Build a local-first web-agent automation platform

You are the lead engineer and owner of a greenfield project. Your job is to design
and build a working, locally-runnable platform for **autonomous web agents** — software
agents that take a natural-language goal, drive a real browser, and reliably extract
structured data or complete multi-step tasks on live websites.

## What the platform should ultimately do

Think of it as a toolkit + runtime for "querying and acting on the web like it were an API":

1. **Semantic querying of pages** — A user describes the data or elements they want in
   plain language or a lightweight schema (e.g. "the product price, title, and rating").
   The system locates the right elements by *meaning*, not brittle CSS/XPath selectors,
   and stays working when a site's layout changes.

2. **Multi-step web agents** — Given a goal ("log in, search for X, collect the first
   20 results into a table"), the agent plans and executes: navigate, click, type,
   paginate, handle forms, wait for content, and recover from failures.

3. **Structured output** — Results come back as clean JSON validated against a
   user-provided schema, not raw HTML.

4. **Reliability at scale** — Retries, self-healing element resolution, rate limiting,
   and the ability to run the same agent across many URLs/sites concurrently.

5. **A developer interface** — At minimum a programmatic SDK/API. Ideally also a small
   local UI / playground to author a query or agent, run it, and watch the browser act
   in real time, with run history and logs.

Everything runs **locally** — local browser automation, local orchestration, and a
local model or API-key-driven model of the user's choice. No dependency on any hosted
proprietary service for the core loop.

## Phase 0 — Ask me questions first (do this before writing any code)

Do NOT start building until you've gathered what you need. Interview me in rounds. Ask
about anything that materially changes the design, including but not limited to:

- Scope for a first milestone vs. the full vision — what does "v1 works" mean to me?
- Preferred language/stack and any I should avoid.
- Which LLM(s) to use for the agent's reasoning, and how keys/models are provided.
- Browser automation engine preferences, headless vs. headful.
- Whether the UI/playground is in-scope for v1 or a later phase.
- Target sites / example tasks I want to demo it on.
- How results get stored/exported, and any persistence/database needs.
- Performance, concurrency, and scale expectations.
- Auth/login handling, anti-bot considerations, and what's out of scope.
- Testing, packaging, and how I'll run it on my machine.

Keep asking, one focused round at a time, until you genuinely have enough to produce a
concrete plan and start. Then summarize the agreed spec back to me and propose a phased
build plan before you begin.

## Stack is your call

No stack is prescribed. Choose whatever language, frameworks, and tools you judge best
for this problem and justify the choice briefly. Optimize for reliability of the web
automation, quality of the agent reasoning loop, and ease of running locally.

## You own the setup — project AND your own harness

You are responsible for standing up the entire project from nothing, and for optimizing
your *own* development environment to move fast. You are explicitly authorized to:

- Scaffold the repo, choose and install dependencies, set up the toolchain, linters,
  formatters, tests, and a clean project structure.
- Configure your Claude Code harness however helps: install or create **skills**, set up
  **hooks**, add **subagents**, configure **MCP servers**, and edit **settings.json** —
  whatever reduces friction and speeds development.
- Add any automation (e.g. a hook that runs tests/format on save, a verify/run skill,
  scheduled checks) you think will improve quality or velocity.
- Initialize git, manage branches, and keep commits clean.

Before installing or configuring harness-level things, briefly tell me what you're adding
and why, then proceed — I don't need to approve every step, just keep me informed.

## Working style

- Bias toward a working end-to-end slice early, then deepen.
- Verify your work by actually running the agent against real pages, not just unit tests.
- Surface tradeoffs with a recommendation rather than open-ended menus.
- Flag anything legally/ethically sensitive (a site's ToS, aggressive scraping) so I can
  decide.

Start with Phase 0: ask me your first round of questions.
