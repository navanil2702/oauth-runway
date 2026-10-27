# OAuth Runway

**How long until your users can connect?** OAuth Runway gives developers building AI agents a guide for each provider. It covers getting your own OAuth app registered and approved: where to start, what to do next, how long it takes (hands-on and waiting), what can block approval, and which steps an agent can do for you.

- **Library**: 7 researched guides chosen to cover different kinds of gates, plus 1 on-demand guide (Dropbox).
- **Live generation**: enter any app name or website and an agent investigates it, runs live checks against its OAuth endpoints, and writes a guide in the same format.
- **Shareable**: every guide has a link (`#gmail`), a copy-as-Markdown export for tickets and docs, and a step checklist that remembers your progress.

## The problem, as I understood it

An agent product needs three things that are easy to confuse:

| | What it is | Who creates it | How often |
|---|---|---|---|
| **Provider OAuth app** | A client ID and secret registered with Google, Slack, etc., with your name, logo, scopes and redirect URIs | You, once per provider | Once |
| **Your integration** | Your code that runs the OAuth flow and calls the API | You | Once |
| **A user's connection** | One user's grant (tokens) to your OAuth app | Each end user | Per user |

Composio's managed OAuth apps let developers skip the first row while prototyping. Users then consent to "Composio" with shared rate limits and fixed scopes. To ship, most teams move to their own app (Composio's docs list branding, custom scopes, rate limits and polling as the reasons). That's where the hidden work is. The provider may require verification, a security assessment, a marketplace review, a partner program, or per-customer admin consent. Until then, users see warnings, hit caps, or can't connect at all.

So the question a developer actually has is **"what stands between me and real users connecting, and how long will it take?"** Every guide answers it with two clocks:

- **You can test in**: how soon you can connect your own account (usually under an hour).
- **Users can connect in**: how soon *any* customer can, with no warnings or caps, including the provider's review wait (anywhere from same day to months).

The gap between those two clocks is the product. The 7 library apps were chosen so each shows a different kind of gate:

| App | Difficulty | Users can connect in | What decides it |
|---|---|---|---|
| GitHub | 2/5 | Same day | No review, but each org owner must install or approve the app |
| Notion | 2/5 | Days after you submit for review (no stated wait) | No Marketplace review needed; users pick which pages the agent can see at consent |
| Outlook | 3/5 | 1 day to 4+ weeks | Publisher verification needs a vetted Microsoft partner account; tenant consent policies may require admin approval |
| Gmail | 4/5 | 6-10 weeks | Reading mail needs restricted scopes, which need Google verification plus a paid annual CASA security assessment |
| Slack | 4/5 | 2-4 months | Installs work right away, but unlisted commercial apps are rate limited, and Marketplace review is slow |
| Salesforce | 4/5 | 1-3 weeks + each customer installs | New Connected Apps are off; External Client Apps must be packaged and installed per org |
| LinkedIn | 4/5 | 1-3+ months | Self-serve scopes only sign in and post; anything more is a vetted partner program |
| Dropbox (live run) | 3/5 | Same day (dev mode, up to 500 users) | Review starts at 50 linked users; you then have 2 weeks to get production approval |

## Key decisions

1. **Scope: the developer's own OAuth app, end to end.** Every guide covers the same arc: create the app, configure and test, get approved for production. It doesn't try to document the API or replace Composio's toolkit docs. It answers the go/no-go and planning questions developers currently email providers about.
2. **Every claim says how we know it.** Steps, gotchas, approval facts and config each carry an evidence level: **tested** (an agent ran a live check), **official** (provider docs), **community** (developer reports; most wait-time figures live here), or **inferred** (unconfirmed). Each guide shows its evidence mix, links its sources, and lists what could not be verified. Wait times are the most useful and least documented part, so the guides keep the provider's stated SLA and what developers report side by side.
3. **Agents attempt what's possible without an account.** Investigators can't sign up or pass review, but they can probe: fetch OIDC discovery documents, call the authorize endpoint with a dummy `client_id`, send dummy credentials to the token endpoint, and check whether the console requires login. That grounds the endpoints and the error a developer will see when misconfigured (for example, Microsoft only rejects a bad client ID *after* sign-in, while Google rejects it immediately). The 7 guides record 39 such checks.
4. **"Agent or you" on every step.** Each step has an owner: *Agent* (research, drafting scope justifications and privacy-policy text, generating config, probing endpoints), *You* (logins, legal identity, payment, demo videos, agreements), or *Provider* (review waits). Each guide also has an explicit handoff section, so it's clear what to delegate.
5. **One investigator, two uses.** The library and live generation share one prompt ([`agent/research_prompt.md`](agent/research_prompt.md)) and one schema ([`agent/guide.schema.json`](agent/guide.schema.json)). A library guide is a live guide that was run ahead of time and then checked. This keeps quality comparable and makes the path to 100 guides a batch job ([`scripts/build_library.py`](scripts/build_library.py)).
6. **Validation in the loop.** The agent submits its guide through a `submit_guide` tool that validates structure and source references (every cited source id must exist). Errors go back to the agent to fix, so a malformed guide never reaches the page.

## How it works

```
             ┌──────────── web/ (one static app) ────────────┐
             │ library table · guide page · live log · share │
             └──────────┬───────────────────────┬────────────┘
       local server mode │                       │ claude.ai artifact mode
                         ▼                       ▼
     server.py  POST /api/generate (SSE)     viewer's Claude (`sample`)
     agent/investigator.py                   + Claude app browser (`mcp`)
       Claude API (claude-opus-5-5)          guides saved to artifact `db`
       web_search · web_fetch (server tools)
       probe_http (local, public hosts only)
       submit_guide → agent/validate.py
```

## Run it

Requires Python 3.9+.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
ANTHROPIC_API_KEY=sk-ant-... .venv/bin/python server.py
```

Open http://localhost:8787. The library works without a key; live generation needs one, and the header shows whether it's on. A live run takes about 2-5 minutes and stays within roughly 10 searches, 15 page reads and a few probes.

Other commands:

```bash
.venv/bin/python -m unittest discover tests
```

```bash
.venv/bin/python -m agent.validate data/guides/*.json data/generated/*.json
```

```bash
.venv/bin/python -m agent.investigator "Zoom" > zoom.json
```

```bash
.venv/bin/python scripts/build_artifact.py --url https://claude.ai/artifact/<id>
```

The last one bundles everything into one HTML file for a claude.ai Artifact. In that version, live generation runs on the viewer's own Claude and researches with the Claude desktop app's browser. In a plain web browser, with no browser tool available, it drafts from model knowledge and marks the whole guide as an unverified draft.

## Verification

Two independent checker agents re-verified **15 high-stakes claims** from six guides against primary sources. Each checker saw only the claim, not the original agent's sources. Results: **6 confirmed, 8 partly right, 1 wrong.** All corrections were applied to the guides, and each guide records the check in `meta.reviewed`. Per-claim details and sources: [verification/REPORT.md](verification/REPORT.md).

What I learned from it:

- **The verdicts held; the details drifted.** No guide's difficulty or headline changed. Errors clustered in four patterns:
  - **Stale numbers.** Salesforce's security review fee was the pre-2023 $2,550 + $150/yr; it is now $999 per review attempt and free for free apps.
  - **Two similar limits merged into one.** Google has a 100-new-user cap for unverified apps, which verification lifts, and a separate lifetime cap that cannot be reset for unapproved sensitive scopes.
  - **Rules stated too broadly.** Slack's "don't store Slack data" applies to Agent/Assistant-UI apps only. LinkedIn's "only product on the app" applies only when requesting the Development tier. Microsoft's consent policy is not limited to multi-tenant apps.
  - **Rollout dates.** Microsoft added mail and calendar scopes to the blocked-consent list around Nov 2025, not mid-2025. Salesforce's "Use Any API Client" stopped working for uninstalled apps in Dec 2025.

  So for scaling, the verifier pass should target numbers, dates and words like "only/always/never". Those are where a single research pass goes wrong.
- **Live checks caught where the docs are wrong or silent.**
  - LinkedIn returns an HTTP 200 error page for a bad `client_id`, not the documented 401. Its discovery `issuer` (`https://www.linkedin.com/oauth`) differs from the docs, which can break strict ID-token validation.
  - GitHub's token endpoint answers an unknown client with a 404, not `incorrect_client_credentials`.
  - Microsoft only reveals a bad client ID after sign-in.

  These are now gotchas in the guides.
- **Still unresolved, and labeled as such in the guides:**
  - Whether Slack's limits for unlisted apps now apply to installs made before May 2025: Slack's own pages disagree.
  - Salesforce's current fee page didn't load; the figure comes from the indexed version.
  - Microsoft's rollout dates come from third-party blogs.
  - Most review wait times come from developer reports, not published SLAs.

## Limitations

- **Nothing past a login was tested.** No accounts were created, so console screens, review forms and post-login errors come from docs and developer reports, not first-hand attempts.
- **Wait times are the weakest data.** Providers rarely publish SLAs. Timelines combine stated maximums with community reports and are marked as such. Treat them as planning ranges.
- **Policies change fast.** Several of the most important findings are from 2025-2026 (Slack's limits on unlisted apps, Salesforce's Connected App shutdown, Microsoft's consent policy, GitHub's expiring OAuth App tokens). Each guide shows its generation date, and the batch script supports `--refresh`. A production version would re-run guides on a schedule and diff them.
- **Live generation was tested offline only in this repo.** The agent loop and the SSE stream are covered by tests with a scripted fake Claude client ([`tests/test_investigator.py`](tests/test_investigator.py)). The Dropbox guide was produced with the same prompt by a Claude Code subagent, not through `server.py`. Running `server.py` with a real key is the remaining end-to-end check.
- **The artifact's live mode depends on the viewer.** It needs a signed-in Claude viewer, and it only has a browser in the Claude desktop app. Elsewhere it falls back to a clearly labeled, unverified draft.
- **The library has 8 guides, not 100.** `scripts/apps.txt` lists the next 40, chosen from Composio's managed toolkits that teams most often move to their own app.

## Scaling to 100

1. Run `scripts/build_library.py scripts/apps.txt --parallel 4` (about 3-5 minutes and roughly $1-3 per app at current Opus pricing; not measured here).
2. Run a verifier pass per guide: a second agent re-checks the headline, the timeline and every `blocker`-impact claim against primary sources (the pass used below). Corrections go in, and the result goes in `meta.reviewed`.
3. Refresh every guide monthly and flag any change in verdict or timeline for human review.
4. Promote facts that apply across providers (for example, Google's restricted scopes affect Gmail, Drive and Calendar alike) into shared snippets so one correction fixes every affected guide.

## Repository layout

```
agent/research_prompt.md   instructions shared by library and live runs
agent/guide.schema.json    the guide format (with evidence levels)
agent/investigator.py      Claude API agent: web search/fetch, probe_http, submit_guide
agent/validate.py          dependency-free guide validation
server.py                  stdlib HTTP server + SSE endpoint
web/                       the app (index.html, app.js, styles.css)
data/guides/               library guides
data/generated/            guides produced by live runs
verification/              fact-check results for a sample of claims
scripts/                   artifact bundler, batch library builder, app list
tests/                     offline tests for the agent loop and server
```

No credentials are stored in this repository. The server reads `ANTHROPIC_API_KEY` from the environment only.
