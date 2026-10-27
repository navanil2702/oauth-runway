/* OAuth Runway web app.
 * Two backends behind one interface:
 *   server mode   - served by server.py; library from /api/guides, live generation over SSE (Claude API agent).
 *   artifact mode - published as a claude.ai Artifact; library embedded in window.__RUNWAY__,
 *                   live generation through the viewer's Claude (`sample`) with the Claude app's
 *                   browser (`mcp` host:claude_browser) as its research tool, guides shared via `db`.
 */
(() => {
  "use strict";

  const EMBED = window.__RUNWAY__ || null;
  const IS_ARTIFACT = !!EMBED;
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $("#app");

  const DIFF_LABEL = { 1: "Minutes", 2: "Self-serve", 3: "Review", 4: "Weeks", 5: "Gated" };
  const EV_TEXT = {
    tested: "An agent ran a live check that confirms it",
    official: "Stated in the provider's own docs or policy",
    community: "Developer reports: forums, blogs, issues",
    inferred: "Reasoning or model knowledge, not confirmed",
  };
  const OWNER_TEXT = { agent: "Agent", you: "You", provider: "Provider", "agent+you": "Agent + you" };

  let guides = new Map();
  let lastGenerated = null;

  // ---------- helpers ----------
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => String(s).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.(com|io|so|ai|app|dev|co|org|net)(\/.*)?$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "app";
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast(label + " copied"); }
    catch {
      const box = document.createElement("textarea");
      box.className = "copybox"; box.value = text; box.readOnly = true;
      const host = $("#copy-fallback"); if (!host) return;
      host.replaceChildren(box); box.focus(); box.select();
      toast("Select all and copy from the box");
    }
  }
  function shareUrl(id) {
    if (IS_ARTIFACT) return (EMBED.artifactUrl || "") + "#" + id;
    return location.origin + location.pathname + "#" + id;
  }

  const meter = (d) => `<span class="meter" data-d="${+d}" title="Difficulty ${+d} of 5"><span class="lights"><i></i><i></i><i></i><i></i><i></i></span><span class="lbl">${+d}/5</span></span>`;
  const ev = (e) => e ? `<span class="ev" data-ev="${h(e)}" title="${h(EV_TEXT[e] || "")}">${h(e)}</span>` : "";
  function srcs(ids, g) {
    if (!ids || !ids.length) return "";
    const map = new Map((g.sources || []).map((s) => [s.id, s]));
    return ids.map((id) => {
      const s = map.get(id); if (!s) return "";
      const href = /^https?:/.test(s.url || "") ? s.url : "#src-" + g.id;
      return `<a class="src" href="${h(href)}" target="_blank" rel="noopener" title="${h(s.title)}">${h(id)}</a>`;
    }).join(" ");
  }

  // ---------- validation (mirrors agent/validate.py) ----------
  function validateGuide(g) {
    const errs = [];
    if (!g || typeof g !== "object") return ["guide must be an object"];
    for (const k of ["id", "name", "provider", "summary", "verdict", "timeline", "approval", "phases", "gotchas", "handoff", "config", "sources", "uncertainties"]) if (!(k in g)) errs.push(`missing '${k}'`);
    if (errs.length) return errs;
    const ids = new Set((g.sources || []).map((s) => s && s.id));
    const EVS = ["tested", "official", "community", "inferred"];
    const refs = (where, it, needEv = true) => {
      if (needEv && !EVS.includes(it.evidence)) errs.push(`${where}: evidence must be one of ${EVS.join("|")}`);
      for (const id of it.source_ids || []) if (!ids.has(id)) errs.push(`${where}: unknown source id ${id}`);
    };
    const d = g.verdict.difficulty;
    if (!Number.isInteger(d) || d < 1 || d > 5) errs.push("verdict.difficulty must be integer 1-5");
    for (const k of ["first_connection", "production", "hands_on_effort", "first_connection_short", "production_short", "hands_on_short"]) if (!g.timeline[k]) errs.push(`timeline.${k} required`);
    if (typeof g.approval.needed_for_production !== "boolean") errs.push("approval.needed_for_production must be boolean");
    if (!Array.isArray(g.phases) || !g.phases.length) errs.push("phases must not be empty");
    (g.phases || []).forEach((p, i) => (p.steps || []).forEach((s, j) => {
      if (!["agent", "you", "provider", "agent+you"].includes(s.owner)) errs.push(`phases[${i}].steps[${j}].owner invalid`);
      refs(`phases[${i}].steps[${j}]`, s);
    }));
    (g.gotchas || []).forEach((x, i) => { if (!["blocker", "delay", "nuance"].includes(x.impact)) errs.push(`gotchas[${i}].impact invalid`); refs(`gotchas[${i}]`, x); });
    if (!(g.handoff.agent_can || []).length || !(g.handoff.you_must || []).length) errs.push("handoff lists must not be empty");
    return errs;
  }

  // ---------- backends ----------
  const serverBackend = {
    label: "Local server",
    async status() { try { const r = await fetch("api/status"); return (await r.json()).live ? "live generation on" : "live generation off (no API key)"; } catch { return ""; } },
    async list() { const r = await fetch("api/guides"); return r.json(); },
    async generate(appName, onEvent) {
      const r = await fetch("api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: appName }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Server returned ${r.status}`); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ""; let result = null;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith("data: ")) continue;
          const evt = JSON.parse(chunk.slice(6));
          if (evt.type === "done") result = evt.guide;
          else if (evt.type === "error") throw new Error(evt.text);
          else onEvent(evt);
        }
      }
      if (!result) throw new Error("The investigation ended without a guide.");
      return result;
    },
  };

  const artifactBackend = {
    label: "Claude artifact",
    db: null,
    async list() {
      const base = EMBED.guides.map((g) => ({ ...g, meta: { collection: "library", ...(g.meta || {}) } }));
      try {
        this.db = await window.claude.use("db");
        if (this.db) {
          const snap = await this.db.collection("guides").get();
          for (const d of snap.docs) {
            const g = d.data(); if (g && g.id && !base.some((b) => b.id === g.id)) base.push({ ...g, meta: { ...(g.meta || {}), collection: "generated" } });
          }
        }
      } catch (e) { console.warn("db unavailable", e); }
      return base;
    },
    async generate(appName, onEvent, signal) {
      const sample = await window.claude.use("sample");
      if (!sample) throw new Error("Live generation needs Claude in this view. Open the artifact on claude.ai or in the Claude app while signed in.");
      const limits = await sample.limits().catch(() => null);
      const canTools = !!(limits && limits.tools);
      const mcp = canTools ? await window.claude.use("mcp") : null;
      let browser = !!mcp;
      const pageText = (res) => {
        const p = res && res.payload;
        if (typeof p === "string") return p;
        const t = (res && res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        return t || JSON.stringify(p ?? "");
      };
      async function read(url, max) {
        await mcp.callTool("host:claude_browser", "navigate", { url }, { cache: false, signal });
        const res = await mcp.callTool("host:claude_browser", "get_page_text", { max_chars: max }, { cache: false, signal });
        return pageText(res).slice(0, max);
      }
      let submitted = null;
      const tools = [];
      if (browser) {
        tools.push({
          name: "web_search",
          description: "Search the web (DuckDuckGo). Returns the results page text with titles and URLs. Use for provider docs, review policies and developer reports of wait times.",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          async execute(input) {
            const q = String(input.query || ""); onEvent({ type: "search", text: q });
            try { return await read("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), 6000); }
            catch (e) { browser = false; onEvent({ type: "error", text: "Browser unavailable: " + (e.message || e.code) }); throw new Error("browser unavailable; continue from knowledge and mark claims inferred"); }
          },
        }, {
          name: "read_page",
          description: "Open a URL in a real browser and return the visible page text (first 12,000 chars). Use for docs pages AND for live checks: OIDC discovery documents, the authorize endpoint with a dummy client_id (record the error shown), and whether the developer console requires login.",
          inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          async execute(input) {
            const url = String(input.url || "");
            if (!/^https:\/\//.test(url)) throw new Error("only https URLs");
            onEvent({ type: "read", text: url });
            try { return await read(url, 12000); }
            catch (e) { throw new Error("could not read page: " + (e.message || e.code)); }
          },
        });
      }
      if (canTools) {
        tools.push({
          name: "submit_guide",
          description: "Submit the finished guide object. It is validated; on errors you get them back and must fix and resubmit.",
          inputSchema: { type: "object", properties: { guide: { type: "object" } }, required: ["guide"] },
          async execute(input) {
            let g = input.guide; if (typeof g === "string") { try { g = JSON.parse(g); } catch { throw new Error("guide must be a JSON object"); } }
            const errs = validateGuide(g);
            if (errs.length) { onEvent({ type: "status", text: `Guide failed validation (${errs.length}); fixing` }); throw new Error("Validation errors:\n- " + errs.slice(0, 25).join("\n- ")); }
            submitted = g; onEvent({ type: "status", text: "Guide validated" }); return "Accepted. Reply with one short sentence; do not repeat the guide.";
          },
        });
      }
      const research = browser
        ? "You have a real browser: `web_search` and `read_page`. Budget: at most 3 searches and 6 page reads, then submit. Use `read_page` for live checks (discovery doc, authorize URL with client_id=oauth-runway-probe) and mark those `tested` with a kind:'test' source."
        : "You have NO web access in this view. Write the guide from what you know, set every evidence level to `inferred` (never official/tested), add sources only as the canonical doc URLs you expect, with titles starting 'Not opened: ', and say clearly in uncertainties that nothing was verified live. Set meta.research to 'knowledge-only'.";
      const prompt = EMBED.prompt.replaceAll("{{APP}}", appName).replaceAll("{{MODE}}", "live") +
        `\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\n## This session\n${research}\n` +
        (canTools ? "Finish by calling `submit_guide` with the complete guide object. Keep text fields concise so the whole guide fits." : "Reply with ONLY the guide JSON object, nothing else. Keep text fields concise.") +
        `\n\n## guide.schema.json\n${EMBED.schema}`;
      onEvent({ type: "status", text: browser ? "Researching with the Claude app's browser" : "No browser in this view: drafting from model knowledge (unverified)" });

      if (!canTools) {
        const g = await sample.json(prompt, { modelTier: "complex", signal });
        const errs = validateGuide(g); if (errs.length) throw new Error("Generated guide was invalid: " + errs.slice(0, 3).join("; "));
        submitted = g;
      } else {
        const res = await sample(prompt, { tools, modelTier: "complex", signal, onText: ({ delta }) => { if (delta && delta.trim()) onEvent({ type: "note", text: delta.trim().slice(0, 300) }); } });
        if (!submitted) throw new Error(res.truncated ? "The answer was cut off before a guide was submitted. Try again." : "Claude finished without submitting a guide.");
      }
      submitted.meta = { ...(submitted.meta || {}), generated_at: new Date().toISOString().slice(0, 10), generated_by: "OAuth Runway (artifact, viewer's Claude)", mode: "live", research: browser ? "browser" : "knowledge-only" };
      submitted.id = slug(submitted.id || appName);
      if (EMBED.guides.some((g) => g.id === submitted.id)) submitted.id += "-live";
      try { if (this.db) await this.db.collection("guides").doc(submitted.id).set(submitted); }
      catch (e) { onEvent({ type: "status", text: "Could not save for other viewers (" + (e.code || "error") + "); this copy stays on your screen" }); }
      return submitted;
    },
  };

  const backend = IS_ARTIFACT ? artifactBackend : serverBackend;

  // ---------- markdown export ----------
  function toMarkdown(g) {
    const L = [];
    const srcMap = new Map((g.sources || []).map((s) => [s.id, s]));
    const cite = (ids) => (ids || []).map((id) => srcMap.get(id) ? `[${id}]` : "").join("");
    L.push(`# ${g.name}: OAuth app setup and approval`, "", `**Provider:** ${g.provider}  `, `**Difficulty:** ${g.verdict.difficulty}/5 (${g.verdict.label})  `,
      `**First connection:** ${g.timeline.first_connection}  `, `**Production:** ${g.timeline.production}  `, `**Hands-on effort:** ${g.timeline.hands_on_effort}`, "",
      `> ${g.verdict.headline}`, "", g.summary, "");
    if (g.timeline.wait_detail) L.push(`**About the wait:** ${g.timeline.wait_detail}`, "");
    const a = g.approval;
    L.push("## Approval", `- Needed for production: ${a.needed_for_production ? "yes" : "no"} (${a.type})`);
    if (a.trigger) L.push(`- Triggered by: ${a.trigger}`);
    if (a.what_happens_without_it) L.push(`- Without it: ${a.what_happens_without_it}`);
    if (a.cost) L.push(`- Cost: ${a.cost}`);
    L.push("");
    for (const p of g.phases) {
      L.push(`## ${p.name}${p.duration ? ` (${p.duration})` : ""}`); if (p.goal) L.push(p.goal);
      p.steps.forEach((s) => L.push(`- [ ] **${s.title}** (${OWNER_TEXT[s.owner] || s.owner}${s.effort ? ", " + s.effort : ""}; ${s.evidence}${cite(s.source_ids)})${s.detail ? ": " + s.detail : ""}${s.url ? ` ${s.url}` : ""}`));
      L.push("");
    }
    L.push("## Requirements and nuances"); g.gotchas.forEach((x) => L.push(`- **[${x.impact}] ${x.title}** (${x.evidence}${cite(x.source_ids)}): ${x.detail}`)); L.push("");
    if ((g.blockers || []).length) { L.push("## If you get stuck"); g.blockers.forEach((b) => L.push(`- **${b.symptom}**: ${b.what_to_do}`)); L.push(""); }
    L.push("## What an agent can do", ...g.handoff.agent_can.map((x) => `- ${x}`), "", "## Where you take over", ...g.handoff.you_must.map((x) => `- ${x}`), "");
    if ((g.tests || []).length) { L.push("## Live checks run"); g.tests.forEach((t) => L.push(`- ${t.check}: ${t.result}`)); L.push(""); }
    if ((g.uncertainties || []).length) { L.push("## Not verified"); g.uncertainties.forEach((u) => L.push(`- ${u}`)); L.push(""); }
    L.push("## Sources"); (g.sources || []).forEach((s) => L.push(`- [${s.id}] ${s.title} (${s.kind}): ${s.url}`));
    L.push("", `_Generated ${g.meta?.generated_at || ""} by OAuth Runway. Evidence levels: tested > official > community > inferred._`);
    return L.join("\n");
  }

  // ---------- views ----------
  function findGuide(q) {
    const s = slug(q); const ql = q.toLowerCase().trim();
    for (const g of guides.values()) {
      if (g.id === s || g.name.toLowerCase() === ql || slug(g.name) === s) return g;
      if (g.website && slug(g.website) === s) return g;
    }
    return null;
  }

  function searchBox(value = "") {
    return `<form class="search" id="lookup" role="search">
      <label class="eyebrow" for="q" style="flex-basis:100%">App name or website</label>
      <input id="q" name="q" autocomplete="off" placeholder="e.g. Dropbox, hubspot.com, Zoom" value="${h(value)}" required>
      <button class="btn primary" type="submit">Get the guide</button>
    </form>`;
  }

  function renderHome() {
    document.title = "OAuth Runway";
    const list = [...guides.values()].sort((a, b) => (a.meta?.collection === b.meta?.collection ? a.verdict.difficulty - b.verdict.difficulty : a.meta?.collection === "library" ? -1 : 1));
    app.innerHTML = `
      <section class="wrap hero">
        <p class="eyebrow">OAuth app setup and approval, per provider</p>
        <h1>How long until your users can connect?</h1>
        <p class="lede">Before an agent can act in your users' accounts, you need your own OAuth app with each provider, and some providers review it first. Look up an app to see the steps, the wait, what can block approval, and which parts an agent can do for you.</p>
        ${searchBox()}
        <p class="hint">Not in the library? An agent researches it live (2 to 5 minutes). Try:
          <button type="button" data-try="Dropbox">Dropbox</button><button type="button" data-try="Zoom">Zoom</button><button type="button" data-try="hubspot.com">hubspot.com</button></p>
      </section>
      <section class="wrap section" aria-labelledby="lib-h">
        <div class="section-head"><h2 id="lib-h">Library</h2><span class="muted">${list.length} guides, sorted easiest first</span></div>
        <div class="table-scroll"><table class="lib">
          <thead><tr><th>App</th><th>Difficulty</th><th>You can test in</th><th>Users can connect in</th><th>Gate</th></tr></thead>
          <tbody>${list.map((g) => `<tr data-id="${h(g.id)}">
            <td><div class="app-cell"><a href="#${h(g.id)}">${h(g.name)}</a><span class="muted">${h(g.provider)}</span>${g.meta?.collection === "generated" ? ` <span><span class="tag live">live-generated</span></span>` : ""}</div></td>
            <td>${meter(g.verdict.difficulty)}<div class="muted" style="font-size:var(--step--1);margin-top:4px">${h(g.verdict.label)}</div></td>
            <td class="tnum">${h(g.timeline.first_connection_short || short(g.timeline.first_connection))}</td>
            <td class="tnum">${h(g.timeline.production_short || short(g.timeline.production))}</td>
            <td>${h(short(g.approval.type, 60))}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
      <section class="wrap section" aria-labelledby="how-h">
        <h2 id="how-h">How to read a guide</h2>
        <div class="explain">
          <div class="stack"><h3>Your app, not your user's connection</h3><p>A provider OAuth app is registered once by you. Every user connection goes through it, so its scopes, branding and review status decide what all your users see. Managed apps (such as Composio's) let you prototype without one. Production usually needs your own.</p></div>
          <div class="stack"><h3>Two clocks</h3><p><b>You can test in</b> is how soon you can connect your own account. <b>Users can connect in</b> is how soon any customer can, with no warnings or caps, including the provider's review wait.</p></div>
          <div class="stack"><h3>Who does each step</h3><p><span class="owner" data-o="agent">Agent</span> work can be delegated. <span class="owner" data-o="you">You</span> steps need your login, legal identity, payment or a decision. <span class="owner" data-o="provider">Provider</span> steps are waits.</p></div>
        </div>
        <div class="legend">${Object.entries(EV_TEXT).map(([k, v]) => `<div>${ev(k)}<span class="muted" style="font-size:var(--step--1)">${h(v)}</span></div>`).join("")}</div>
      </section>`;
    bindSearch();
    app.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.tagName !== "A") location.hash = tr.dataset.id; }));
    app.querySelectorAll("[data-try]").forEach((b) => b.addEventListener("click", () => { $("#q").value = b.dataset.try; $("#lookup").requestSubmit(); }));
  }

  function short(s, n = 48) {
    s = String(s || ""); const cut = s.split(/[(;:]|\. |, | plus | for (?=[a-z])/)[0].trim();
    return cut.length > n ? cut.slice(0, n - 1) + "…" : cut;
  }

  function bindSearch() {
    const f = $("#lookup"); if (!f) return;
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("#q").value.trim(); if (!q) return;
      const g = findGuide(q);
      if (g) location.hash = g.id; else renderGenerate(q);
    });
  }

  function evidenceMix(g) {
    const c = { tested: 0, official: 0, community: 0, inferred: 0 };
    const add = (e) => { if (e in c) c[e]++; };
    g.phases.forEach((p) => p.steps.forEach((s) => add(s.evidence)));
    g.gotchas.forEach((x) => add(x.evidence));
    add(g.approval.evidence); add(g.config.evidence);
    (g.blockers || []).forEach((b) => add(b.evidence));
    const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    return `<div class="ev-mix"><span class="eyebrow">Evidence behind ${total} claims</span>
      <div class="ev-bar">${Object.entries(c).map(([k, v]) => v ? `<span style="width:${(v / total) * 100}%;background:var(--ev-${k})" title="${k}: ${v}"></span>` : "").join("")}</div>
      <div class="ev-rows">${Object.entries(c).map(([k, v]) => `<div>${ev(k)}<span class="tnum">${v}</span></div>`).join("")}</div></div>`;
  }

  function renderGuide(g) {
    document.title = `${g.name} OAuth guide · OAuth Runway`;
    const doneKey = "runway-done-" + g.id;
    const done = new Set(store.get(doneKey) || []);
    const allSteps = g.phases.flatMap((p, pi) => p.steps.map((s, si) => ({ ...s, key: `${pi}.${si}`, phase: p.name })));
    const next = allSteps.find((s) => !done.has(s.key));
    const a = g.approval; const tl = g.timeline;
    const gotchas = [...g.gotchas].sort((x, y) => ["blocker", "delay", "nuance"].indexOf(x.impact) - ["blocker", "delay", "nuance"].indexOf(y.impact));
    const knowledgeOnly = g.meta?.research === "knowledge-only";

    app.innerHTML = `<div class="wrap guide">
      <article class="guide-main">
        <header class="ghead">
          <p class="eyebrow"><a href="#">Library</a> / ${h(g.category || "OAuth guide")}${g.meta?.mode === "live" ? ' <span class="tag live">live-generated</span>' : ""}</p>
          <h1>${h(g.name)}</h1>
          <p class="provider">OAuth app issued by ${h(g.provider)}${g.website ? ` · <a href="${h(g.website)}" target="_blank" rel="noopener">${h(g.website.replace(/^https?:\/\//, ""))}</a>` : ""}</p>
          ${knowledgeOnly ? `<div class="banner"><b>Unverified draft.</b> This view had no browser, so the agent wrote this from model knowledge without opening any source. Treat every claim as a lead to check, or regenerate it from the local server or the Claude desktop app.</div>` : ""}
          <p class="summary">${h(g.summary)}</p>
        </header>

        <section class="verdict" aria-label="At a glance">
          <div><span class="eyebrow">Difficulty</span>${meter(g.verdict.difficulty)}<span class="big">${h(g.verdict.label)}</span></div>
          <div><span class="eyebrow">You can test in</span><span class="big">${h(tl.first_connection_short || short(tl.first_connection, 40))}</span><span class="small">${h(tl.first_connection)}</span></div>
          <div><span class="eyebrow">Users can connect in</span><span class="big">${h(tl.production_short || short(tl.production, 40))}</span><span class="small">${h(tl.production)}</span></div>
          <div><span class="eyebrow">Hands-on effort</span><span class="big">${h(tl.hands_on_short || short(tl.hands_on_effort, 40))}</span><span class="small">${h(tl.hands_on_effort)}</span></div>
        </section>
        <p class="headline">${h(g.verdict.headline)}</p>
        ${tl.wait_detail ? `<p class="wait"><b>About the wait.</b> ${h(tl.wait_detail)}</p>` : ""}

        ${next ? `<section class="next" aria-label="Next step"><span class="eyebrow">Next step · ${h(next.phase)}</span><h3>${h(next.title)}</h3>
          <div class="step-meta"><span class="owner" data-o="${h(next.owner)}">${h(OWNER_TEXT[next.owner] || next.owner)}</span>${next.effort ? `<span>${h(next.effort)}</span>` : ""}${next.url ? `<a href="${h(next.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</div></section>`
        : `<section class="next"><h3>All steps checked off.</h3><p class="muted">Keep the requirements below in mind as you scale.</p></section>`}

        <section class="gsec" id="approval-${h(g.id)}"><h2>Approval</h2>
          <dl class="kv">
            <dt>Needed for production</dt><dd><b>${a.needed_for_production ? "Yes" : "No"}</b>: ${h(a.type)} ${ev(a.evidence)} ${srcs(a.source_ids, g)}</dd>
            ${a.trigger ? `<dt>What triggers it</dt><dd>${h(a.trigger)}</dd>` : ""}
            ${a.what_happens_without_it ? `<dt>Without it</dt><dd>${h(a.what_happens_without_it)}</dd>` : ""}
            ${a.cost ? `<dt>Cost</dt><dd>${h(a.cost)}</dd>` : ""}
            ${g.managed_option?.when_you_need_your_own ? `<dt>Managed app instead?</dt><dd>${g.managed_option.composio_managed === "yes" ? "Composio has a managed app you can prototype with. " : ""}${h(g.managed_option.when_you_need_your_own)}</dd>` : ""}
          </dl>
        </section>

        <section class="gsec" id="steps-${h(g.id)}"><div class="section-head"><h2>Steps</h2><span class="muted tnum" id="progress">${done.size}/${allSteps.length} done</span></div>
          ${(g.prerequisites || []).length ? `<div class="prereq"><span class="eyebrow">Before you start</span><ul>${g.prerequisites.map((p) => `<li>${h(p.item)}${p.why ? ` <span class="muted">· ${h(p.why)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
          ${g.phases.map((p, pi) => `<div class="phase"><div class="phase-head"><h3>${h(p.name)}</h3>${p.duration ? `<span class="muted tnum">${h(p.duration)}</span>` : ""}${p.goal ? `<p class="goal">${h(p.goal)}</p>` : ""}</div>
            <ol class="steps">${p.steps.map((s, si) => { const k = `${pi}.${si}`; return `<li class="step${done.has(k) ? " done" : ""}">
              <input type="checkbox" id="st-${h(g.id)}-${k}" data-k="${k}" ${done.has(k) ? "checked" : ""} aria-label="Mark done">
              <div><label class="step-title" for="st-${h(g.id)}-${k}">${h(s.title)}</label>${s.detail ? `<p class="step-detail">${h(s.detail)}</p>` : ""}
              <div class="step-meta"><span class="owner" data-o="${h(s.owner)}">${h(OWNER_TEXT[s.owner] || s.owner)}</span>${s.effort ? `<span>${h(s.effort)}</span>` : ""}${ev(s.evidence)} ${srcs(s.source_ids, g)}${s.url ? `<a href="${h(s.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</div></div></li>`; }).join("")}</ol></div>`).join("")}
        </section>

        <section class="gsec" id="nuance-${h(g.id)}"><h2>Requirements and nuances</h2>
          <div class="items">${gotchas.map((x) => `<div class="item"><div class="row"><span class="impact" data-i="${h(x.impact)}">${h(x.impact)}</span><h3>${h(x.title)}</h3></div><p class="body">${h(x.detail)}</p><div class="step-meta">${ev(x.evidence)} ${srcs(x.source_ids, g)}</div></div>`).join("")}</div>
        </section>

        ${(g.blockers || []).length ? `<section class="gsec" id="stuck-${h(g.id)}"><h2>If you get stuck</h2>
          <div class="items">${g.blockers.map((b) => `<div class="item"><h3>${h(b.symptom)}</h3><p class="body">${h(b.what_to_do)}</p>${b.evidence || (b.source_ids || []).length ? `<div class="step-meta">${ev(b.evidence)} ${srcs(b.source_ids, g)}</div>` : ""}</div>`).join("")}</div></section>` : ""}

        <section class="gsec" id="handoff-${h(g.id)}"><h2>Agent or you</h2>
          <div class="handoff"><div><span class="owner" data-o="agent">An agent can</span><ul>${g.handoff.agent_can.map((x) => `<li>${h(x)}</li>`).join("")}</ul></div>
          <div><span class="owner" data-o="you">You must</span><ul>${g.handoff.you_must.map((x) => `<li>${h(x)}</li>`).join("")}</ul></div></div>
        </section>

        <section class="gsec" id="config-${h(g.id)}"><h2>Configuration ${ev(g.config.evidence)} ${srcs(g.config.source_ids, g)}</h2>
          <dl class="kv">
            ${g.config.console_url ? `<dt>Developer console</dt><dd><a href="${h(g.config.console_url)}" target="_blank" rel="noopener">${h(g.config.console_url)}</a></dd>` : ""}
            ${g.config.authorize_url ? `<dt>Authorize URL</dt><dd><code>${h(g.config.authorize_url)}</code></dd>` : ""}
            ${g.config.token_url ? `<dt>Token URL</dt><dd><code>${h(g.config.token_url)}</code></dd>` : ""}
            ${g.config.redirect_uri_rules ? `<dt>Redirect URIs</dt><dd>${h(g.config.redirect_uri_rules)}</dd>` : ""}
            ${g.config.pkce ? `<dt>PKCE</dt><dd>${h(g.config.pkce)}</dd>` : ""}
            ${g.config.refresh_tokens ? `<dt>Refresh tokens</dt><dd>${h(g.config.refresh_tokens)}</dd>` : ""}
          </dl>
          ${(g.config.scopes || []).length ? `<div class="table-scroll"><table class="scopes"><thead><tr><th>Scope</th><th>Tier</th><th>Note</th></tr></thead><tbody>${g.config.scopes.map((s) => `<tr><td>${h(s.scope)}</td><td>${h(s.tier || "")}</td><td>${h(s.note || "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
        </section>

        <section class="gsec" id="evidence-${h(g.id)}"><h2>What we checked</h2>
          ${(g.tests || []).length ? `<h3>Live checks the agent ran</h3><div class="tests">${g.tests.map((t) => `<div class="test"><b>${h(t.check)}</b>${t.method ? `<span class="res">${h(t.method)}</span>` : ""}<span>${h(t.result)}</span>${t.supports ? `<span class="muted" style="font-size:var(--step--1)">Supports: ${h(t.supports)}</span>` : ""}</div>`).join("")}</div>` : ""}
          ${g.meta?.reviewed ? `<h3>Second review</h3><p>${h(g.meta.reviewed)}</p>` : ""}
          <h3>Not verified</h3><ul class="unc">${(g.uncertainties || []).map((u) => `<li>${h(u)}</li>`).join("") || "<li>Nothing flagged.</li>"}</ul>
          <h3 id="src-${h(g.id)}">Sources</h3><ol class="sources">${(g.sources || []).map((s) => `<li><span class="mono muted">${h(s.id)}</span><span>${/^https?:/.test(s.url || "") ? `<a href="${h(s.url)}" target="_blank" rel="noopener">${h(s.title)}</a>` : h(s.title)} <span class="muted">· ${h(s.kind)}${s.accessed ? " · " + h(s.accessed) : ""}</span></span></li>`).join("")}</ol>
          <p class="muted" style="font-size:var(--step--1)">Generated ${h(g.meta?.generated_at || "")} by ${h(g.meta?.generated_by || "an OAuth Runway agent")}. Provider policies change; check dates on sources before you rely on them.</p>
        </section>
      </article>

      <aside class="rail">
        ${evidenceMix(g)}
        <div class="share"><span class="eyebrow">Share</span>
          <button class="btn" id="copy-link" type="button">Copy link</button>
          <button class="btn" id="copy-md" type="button">Copy as Markdown</button>
          <button class="btn" id="regen" type="button">Re-check live</button>
          <div id="copy-fallback"></div>
        </div>
        <nav aria-label="On this page"><span class="eyebrow">On this page</span>
          <a href="#approval-${h(g.id)}">Approval</a><a href="#steps-${h(g.id)}">Steps</a><a href="#nuance-${h(g.id)}">Requirements and nuances</a>${(g.blockers || []).length ? `<a href="#stuck-${h(g.id)}">If you get stuck</a>` : ""}<a href="#handoff-${h(g.id)}">Agent or you</a><a href="#config-${h(g.id)}">Configuration</a><a href="#evidence-${h(g.id)}">What we checked</a></nav>
      </aside>
    </div>`;

    app.querySelectorAll(".step input").forEach((cb) => cb.addEventListener("change", () => {
      cb.checked ? done.add(cb.dataset.k) : done.delete(cb.dataset.k);
      store.set(doneKey, [...done]);
      renderGuide(g);
    }));
    app.querySelectorAll('.rail nav a, a[href^="#approval-"], a[href^="#src-"]').forEach((a) => a.addEventListener("click", (e) => {
      const el = document.getElementById(a.getAttribute("href").slice(1)); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: "smooth" }); }
    }));
    $("#copy-link").addEventListener("click", () => copy(shareUrl(g.id), "Link"));
    $("#copy-md").addEventListener("click", () => copy(toMarkdown(g), "Markdown"));
    $("#regen").addEventListener("click", () => renderGenerate(g.name));
  }

  function renderGenerate(appName) {
    document.title = `Investigating ${appName} · OAuth Runway`;
    const started = Date.now();
    const ctrl = new AbortController();
    app.innerHTML = `<div class="wrap gen">
      <p class="eyebrow"><a href="#">Library</a> / Live investigation</p>
      <div class="gen-head"><h1>${h(appName)}</h1><span class="muted tnum" id="elapsed"><span class="pulse"></span>0s</span></div>
      <p class="muted">An agent is reading ${h(appName)}'s developer docs, review policies and developer reports, and running live checks against its OAuth endpoints. It uses the same instructions and format as the library guides. This usually takes 2 to 5 minutes.</p>
      <ol class="log" id="log" aria-live="polite"></ol>
      <div><button class="btn" id="stop" type="button">Stop</button></div></div>`;
    const log = $("#log");
    const timer = setInterval(() => { const el = $("#elapsed"); if (el) el.innerHTML = `<span class="pulse"></span>${Math.round((Date.now() - started) / 1000)}s`; else clearInterval(timer); }, 1000);
    const KIND = { search: "Search", fetch: "Read", read: "Read", probe: "Probe", probe_result: "Result", thought: "Thinking", note: "Note", status: "Status", error: "Problem" };
    const add = (e) => {
      const li = document.createElement("li"); if (e.type === "thought") li.className = "thought";
      li.innerHTML = `<span class="k" data-k="${h(e.type)}">${h(KIND[e.type] || e.type)}</span><span class="t">${h(e.text || "")}</span>`;
      log.appendChild(li); log.scrollTop = log.scrollHeight;
    };
    $("#stop").addEventListener("click", () => ctrl.abort());
    backend.generate(appName, add, ctrl.signal).then((g) => {
      clearInterval(timer);
      g.meta = { ...(g.meta || {}), collection: "generated" };
      guides.set(g.id, g); lastGenerated = g;
      if (location.hash.slice(1) === g.id) renderGuide(g); else location.hash = g.id;
      toast("Guide ready");
    }).catch((err) => {
      clearInterval(timer);
      const msg = err && (err.message || err.code) || String(err);
      add({ type: "error", text: msg });
      const el = $("#elapsed"); if (el) el.textContent = "Stopped";
      const s = $("#stop"); if (s) { s.textContent = "Back to library"; s.onclick = () => { location.hash = ""; renderHome(); }; }
    });
  }

  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    const g = guides.get(id) || (lastGenerated && lastGenerated.id === id ? lastGenerated : null);
    if (g) { renderGuide(g); window.scrollTo(0, 0); return; }
    if (id && /^(approval|steps|nuance|stuck|handoff|config|evidence|src)-/.test(id)) return; // in-page anchor
    renderHome();
  }

  async function boot() {
    $("#mode").textContent = backend.label;
    if (backend.status) backend.status().then((t) => { if (t) $("#mode").textContent = `${backend.label} · ${t}`; });
    try {
      const list = await backend.list();
      guides = new Map(list.map((g) => [g.id, g]));
    } catch (e) {
      app.innerHTML = `<div class="wrap section"><h2>Could not load the library</h2><p class="muted">${h(e.message || e)}</p></div>`;
      return;
    }
    window.addEventListener("hashchange", route);
    route();
  }
  boot();
})();
