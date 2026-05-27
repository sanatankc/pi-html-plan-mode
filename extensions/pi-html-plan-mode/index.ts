import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const PLAN_TOOL = "save_html_plan";
const READ_ONLY_TOOLS = ["read", "bash", PLAN_TOOL];
const NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const DEFAULT_PORT = 17391;

type Scope = "local" | "global" | "custom";

type PlanMeta = {
  id: string;
  title: string;
  scope: Scope;
  root: string;
  dir: string;
  createdAt: string;
  updatedAt: string;
  status: "planning" | "building" | "built";
  version: number;
};

type Comment = {
  id: string;
  targetId: string;
  selectedText?: string;
  type?: string;
  body: string;
  resolved?: boolean;
  createdAt: string;
};

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\btee\b/i, /\btruncate\b/i, /\bdd\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\breboot\b/i, /\bshutdown\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];
const SAFE_PATTERNS = [
  /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
  /^\s*sed\s+-n/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version/i,
  /^\s*python3?\s+--version/i,
  /^\s*curl\s/i,
];

function isSafeCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) && SAFE_PATTERNS.some((p) => p.test(command));
}

function cwd(): string { return process.cwd(); }
function nowIso(): string { return new Date().toISOString(); }
function slugify(s: string): string { return (s || "plan").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "plan"; }
function escapeHtml(s: string): string { return s.replace(/[&<>\"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]!)); }

function inGitRepo(): boolean {
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: cwd(), stdio: "ignore" }); return true; } catch { return false; }
}
function projectRoot(): string {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return cwd(); }
}
function globalPlansRoot(): string { return join(homedir(), ".pi", "agent", "html-plans"); }
function localPlansRoot(): string { return join(projectRoot(), ".pi", "plans"); }
function pickRoot(scope: Scope, out?: string): string {
  if (scope === "custom" && out) return resolve(out);
  if (scope === "global") return globalPlansRoot();
  return localPlansRoot();
}
function parseArgs(args: string): { action: string; task: string; scope?: Scope; out?: string; id?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0] && ["open", "list", "modify", "build", "new"].includes(parts[0]) ? parts.shift()! : "new";
  let scope: Scope | undefined;
  let out: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "--local") scope = "local";
    else if (p === "--global") scope = "global";
    else if (p === "--out") { scope = "custom"; out = parts[++i]; }
    else rest.push(p);
  }
  return { action, task: rest.join(" "), scope, out, id: rest[0] };
}

function extractMain(html: string): string {
  const m = html.match(/<main\b[^>]*class=["'][^"']*agent-plan[^"']*["'][^>]*>[\s\S]*?<\/main>/i);
  if (m) return m[0];
  const stripped = html.replace(/<!doctype[\s\S]*?>/ig, "").replace(/<\/?html[^>]*>/ig, "").replace(/<\/?body[^>]*>/ig, "").trim();
  return `<main class="agent-plan">\n${stripped}\n</main>`;
}
function sanitizePlanHtml(html: string): string {
  return extractMain(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; } }
function writeJson(path: string, data: unknown): void { writeFileSync(path, JSON.stringify(data, null, 2)); }
function findPlanDir(id: string): string | undefined {
  const candidates = [join(localPlansRoot(), id), join(globalPlansRoot(), id), resolve(id)];
  return candidates.find((p) => existsSync(join(p, "meta.json")));
}
function loadPlan(idOrDir: string): { dir: string; meta: PlanMeta; body: string; comments: Comment[] } | undefined {
  const dir = findPlanDir(idOrDir);
  if (!dir) return undefined;
  return {
    dir,
    meta: readJson<PlanMeta>(join(dir, "meta.json"), {} as PlanMeta),
    body: readFileSync(join(dir, "plan.body.html"), "utf8"),
    comments: readJson<Comment[]>(join(dir, "comments.json"), []),
  };
}

function markdownFromPlan(plan: { meta: PlanMeta; body: string; comments: Comment[] }): string {
  const text = plan.body
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
  const comments = plan.comments.filter(c => !c.resolved).map((c, i) => `### Comment ${i + 1} (${c.type || "comment"})\nTarget: ${c.targetId}\n${c.selectedText ? `Selected text: ${c.selectedText}\n` : ""}\n${c.body}`).join("\n\n");
  return `# ${plan.meta.title}\n\n## Plan Text\n\n${text}\n\n## Review Comments / Decisions\n\n${comments || "No unresolved comments."}`;
}

function renderPlanHtml(meta: PlanMeta, body: string, comments: Comment[], port: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meta.title)}</title><style>${CSS}</style></head><body data-plan-id="${escapeHtml(meta.id)}">
<header class="review-header"><div><div class="eyebrow">Pi HTML Plan Mode</div><h1>${escapeHtml(meta.title)}</h1><div class="meta"><span>${escapeHtml(meta.status)}</span><span>v${meta.version}</span><span>${escapeHtml(meta.scope)}</span><span>${escapeHtml(meta.updatedAt.slice(0,19).replace('T',' '))}</span></div></div><div class="actions"><button id="copyCmd" class="secondary">Copy Command</button><button id="modify" class="secondary">Modify Plan</button><button id="build" class="primary">Build</button></div></header>
<div class="shell"><div id="plan-wrap">${body}</div><aside class="comments"><div class="comments-head"><h2>Comments</h2><button id="addGeneral">+</button></div><p class="hint">Select text or click a line/card, then add a comment. Comments become instructions for Modify/Build.</p><div id="commentList"></div></aside></div>
<div id="popover" hidden><select id="ctype"><option>comment</option><option>question-answer</option><option>decision</option><option>change-request</option><option>concern</option><option>must-have</option><option>nice-to-have</option></select><textarea id="cbody" placeholder="Add your comment..."></textarea><div><button id="saveComment">Save</button><button id="cancelComment">Cancel</button></div></div>
<script>window.__PLAN__=${JSON.stringify({ id: meta.id, comments, port })};</script><script>${JS}</script></body></html>`;
}

function savePlanFiles(meta: PlanMeta, body: string, comments: Comment[], port: number): void {
  mkdirSync(meta.dir, { recursive: true });
  writeFileSync(join(meta.dir, "plan.body.html"), body);
  writeJson(join(meta.dir, "comments.json"), comments);
  writeJson(join(meta.dir, "meta.json"), meta);
  writeFileSync(join(meta.dir, "plan.html"), renderPlanHtml(meta, body, comments, port));
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
}

export default function htmlPlanMode(pi: ExtensionAPI): void {
  let planMode = false;
  let activeToolsBefore: string[] | null = null;
  let activePlanId: string | undefined;
  let lastCtx: ExtensionContext | undefined;
  let port = DEFAULT_PORT;

  function setStatus(ctx?: ExtensionContext): void {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("html-plan", planMode ? ctx.ui.theme.fg("warning", `☷ plan${activePlanId ? ` ${activePlanId.slice(0,8)}` : ""}`) : undefined);
  }
  function enterPlan(ctx?: ExtensionContext): void {
    if (!planMode) activeToolsBefore = pi.getActiveTools();
    planMode = true;
    pi.setActiveTools(Array.from(new Set([...READ_ONLY_TOOLS])));
    setStatus(ctx);
  }
  function exitPlan(ctx?: ExtensionContext): void {
    planMode = false;
    pi.setActiveTools(activeToolsBefore && activeToolsBefore.length ? activeToolsBefore : NORMAL_TOOLS);
    activeToolsBefore = null;
    setStatus(ctx);
  }

  function sendModify(id: string): void {
    enterPlan(lastCtx);
    const plan = loadPlan(id);
    if (!plan) return;
    pi.sendUserMessage(`[HTML_PLAN_ACTION: modify]\nPlan ID: ${id}\n\nStay in HTML plan mode. Revise the plan using the review comments below. Do not implement anything and do not edit project files. Return/call save_html_plan with complete updated <main class="agent-plan"> HTML only.\n\n${markdownFromPlan(plan)}`);
  }
  function sendBuild(id: string): void {
    exitPlan(lastCtx);
    const plan = loadPlan(id);
    if (!plan) return;
    plan.meta.status = "building"; plan.meta.updatedAt = nowIso(); savePlanFiles(plan.meta, plan.body, plan.comments, port);
    pi.sendUserMessage(`[HTML_PLAN_ACTION: build]\nPlan ID: ${id}\n\nExit plan mode and implement this reviewed plan. Review comments and decisions are binding unless impossible; call out conflicts before proceeding.\n\n${markdownFromPlan(plan)}`);
  }

  function startServer(): void {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const parts = url.pathname.split("/").filter(Boolean);
      try {
        if (url.pathname === "/health") return json(res, { ok: true });
        if (parts[0] === "plans" && parts[1]) {
          const plan = loadPlan(parts[1]);
          if (!plan) return notFound(res);
          html(res, renderPlanHtml(plan.meta, plan.body, plan.comments, port));
          return;
        }
        if (parts[0] === "api" && parts[1] === "plans" && parts[2]) {
          const id = parts[2]; const plan = loadPlan(id); if (!plan) return notFound(res);
          if (parts[3] === "comments" && req.method === "GET") return json(res, plan.comments);
          if (parts[3] === "comments" && req.method === "POST") {
            const comments = await bodyJson<Comment[]>(req); writeJson(join(plan.dir, "comments.json"), comments); savePlanFiles(plan.meta, plan.body, comments, port); return json(res, { ok: true });
          }
          if (parts[3] === "modify" && req.method === "POST") { sendModify(id); return json(res, { ok: true, action: "modify" }); }
          if (parts[3] === "build" && req.method === "POST") { sendBuild(id); return json(res, { ok: true, action: "build" }); }
          if (parts[3] === "command") return json(res, { modify: `/html-plan modify ${id}`, build: `/html-plan build ${id}` });
        }
        notFound(res);
      } catch (e) { res.statusCode = 500; res.end(String(e)); }
    });
    server.on("error", () => { port += 1; server.listen(port, "127.0.0.1"); });
    server.listen(port, "127.0.0.1");
  }

  pi.registerFlag("html-plan", { description: "Start with HTML plan mode enabled", type: "boolean", default: false });

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Save HTML Plan",
    description: "Save an agent-authored HTML plan body (<main class=\"agent-plan\">...</main>) and open the browser review UI.",
    parameters: Type.Object({
      title: Type.String({ description: "Short plan title" }),
      html: Type.String({ description: "Complete semantic HTML body. Prefer exactly one <main class=\"agent-plan\">...</main>. No scripts." }),
    }),
    async execute(_toolCallId, params) {
      const title = String(params.title || "HTML Plan");
      const root = pickRoot((globalThis as any).__htmlPlanScope || (inGitRepo() ? "local" : "global"), (globalThis as any).__htmlPlanOut);
      const existing = activePlanId ? loadPlan(activePlanId) : undefined;
      const id = existing?.meta.id || `${slugify(title)}-${Date.now().toString(36)}`;
      const dir = existing?.dir || join(root, id);
      const body = sanitizePlanHtml(String(params.html || ""));
      const meta: PlanMeta = existing?.meta || { id, title, scope: ((globalThis as any).__htmlPlanScope || (inGitRepo() ? "local" : "global")), root: projectRoot(), dir, createdAt: nowIso(), updatedAt: nowIso(), status: "planning", version: 0 };
      meta.title = title; meta.updatedAt = nowIso(); meta.version += 1; meta.dir = dir;
      activePlanId = id;
      savePlanFiles(meta, body, existing?.comments || [], port);
      openBrowser(`http://127.0.0.1:${port}/plans/${id}`);
      return { content: [{ type: "text", text: `Saved HTML plan ${id}\n${dir}\nOpen: http://127.0.0.1:${port}/plans/${id}` }], details: { id, dir, url: `http://127.0.0.1:${port}/plans/${id}` } };
    },
  });

  pi.registerCommand("html-plan", {
    description: "HTML plan mode: /html-plan [--local|--global|--out PATH] <task>, open/list/modify/build",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const parsed = parseArgs(args);
      if (parsed.action === "list") {
        const dirs = [localPlansRoot(), globalPlansRoot()].flatMap(root => existsSync(root) ? readdirSync(root).map(id => join(root, id)) : []).filter(d => existsSync(join(d, "meta.json")));
        ctx.ui.notify(dirs.map(d => `${readJson<PlanMeta>(join(d,"meta.json"),{} as PlanMeta).id} — ${d}`).join("\n") || "No plans found", "info"); return;
      }
      if (parsed.action === "open") { const id = parsed.id || activePlanId; if (!id) return ctx.ui.notify("Usage: /html-plan open <id>", "warning"); openBrowser(`http://127.0.0.1:${port}/plans/${id}`); return; }
      if (parsed.action === "modify") { const id = parsed.id || activePlanId; if (!id) return ctx.ui.notify("Usage: /html-plan modify <id>", "warning"); sendModify(id); return; }
      if (parsed.action === "build") { const id = parsed.id || activePlanId; if (!id) return ctx.ui.notify("Usage: /html-plan build <id>", "warning"); sendBuild(id); return; }
      if (!parsed.task.trim()) return ctx.ui.notify("Usage: /html-plan [--local|--global|--out PATH] <task>", "warning");
      (globalThis as any).__htmlPlanScope = parsed.scope || (inGitRepo() ? "local" : "global");
      (globalThis as any).__htmlPlanOut = parsed.out;
      activePlanId = undefined;
      enterPlan(ctx);
      pi.sendUserMessage(`Create an HTML implementation plan for this task: ${parsed.task}\n\nUse read-only exploration first. Do not modify project files. When ready, call the ${PLAN_TOOL} tool with a title and exactly one semantic <main class="agent-plan">...</main> plan body.`);
    },
  });

  pi.on("tool_call", async (event) => {
    if (!planMode) return;
    if (event.toolName === "edit" || event.toolName === "write") return { block: true, reason: "HTML plan mode is read-only. Use Build to exit plan mode." };
    if (event.toolName === "bash") {
      const command = String(event.input.command || "");
      if (!isSafeCommand(command)) return { block: true, reason: `HTML plan mode blocked non-read-only bash command: ${command}` };
    }
  });

  pi.on("before_agent_start", async () => {
    if (!planMode) return;
    return { message: { customType: "html-plan-mode", display: false, content: HTML_PLAN_PROMPT } };
  });
  pi.on("session_start", async (_event, ctx) => { lastCtx = ctx; startServer(); if (pi.getFlag("html-plan") === true) enterPlan(ctx); });
}

function json(res: ServerResponse, data: unknown): void { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); }
function html(res: ServerResponse, data: string): void { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(data); }
function notFound(res: ServerResponse): void { res.statusCode = 404; res.end("not found"); }
function bodyJson<T>(req: IncomingMessage): Promise<T> { return new Promise((resolve, reject) => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { resolve(JSON.parse(s || "null")); } catch(e) { reject(e); } }); }); }

const HTML_PLAN_PROMPT = `[HTML PLAN MODE ACTIVE]
You are in read-only planning mode.

Explore the codebase safely using read/bash. Do not modify files. Bash is restricted to read-only commands.

When you have enough context, call save_html_plan with:
- title: a concise title
- html: exactly one <main class="agent-plan">...</main> body

HTML authoring rules:
- The agent owns only <main class="agent-plan">...</main>. Do not output full HTML, scripts, or external assets.
- Use semantic HTML: article/section/h1-h3/p/ul/ol/table/blockquote/details where useful.
- Make the design task-specific. You may use flexible layouts, cards, tables, timelines, checklists, and callouts.
- Available theme classes: card, grid, callout, question, decision, risk, step, badge, muted, kbd, timeline, two-col.
- Put open questions in obvious .question blocks. The user will answer by commenting in the browser.
- Keep spacing clean, minimal, readable, and consistent.
- Do not implement anything until the user clicks Build.`;

const CSS = `:root{--bg:#0b0d12;--panel:#121622;--panel2:#171c2a;--text:#eef2ff;--muted:#94a3b8;--line:#263041;--accent:#8aa2ff;--accent2:#b3c0ff;--warn:#fbbf24;--danger:#fb7185;--success:#34d399;--shadow:0 18px 50px rgba(0,0,0,.35)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#17203a,#0b0d12 45%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.review-header{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;gap:24px;align-items:center;padding:18px 28px;background:rgba(11,13,18,.82);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent2);font-weight:800}.review-header h1{margin:3px 0;font-size:22px}.meta{display:flex;gap:8px;flex-wrap:wrap}.meta span,.badge{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 8px;background:#0d1320}.actions{display:flex;gap:10px}button{border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;color:var(--text)}button.primary{background:linear-gradient(135deg,var(--accent),#6ee7b7);color:#08111f}button.secondary{background:var(--panel2);border:1px solid var(--line)}.shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px;max-width:1480px;margin:0 auto;padding:26px}.agent-plan{background:rgba(18,22,34,.86);border:1px solid var(--line);border-radius:22px;padding:34px;box-shadow:var(--shadow);line-height:1.6}.agent-plan h1{font-size:36px;line-height:1.12;margin:0 0 12px}.agent-plan h2{font-size:24px;margin:32px 0 12px}.agent-plan h3{font-size:18px;margin:22px 0 8px}.agent-plan p,.agent-plan li{color:#dbe4ff}.agent-plan a{color:var(--accent2)}.agent-plan table{width:100%;border-collapse:collapse;margin:14px 0}.agent-plan th,.agent-plan td{border:1px solid var(--line);padding:10px;text-align:left}.agent-plan th{color:var(--accent2);background:#101624}.card,.callout,.question,.decision,.risk,.step{border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0;background:rgba(23,28,42,.82)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}.callout{border-color:#36518f}.question{border-color:#7c5cff;background:rgba(124,92,255,.08)}.decision{border-color:#22c55e;background:rgba(34,197,94,.07)}.risk{border-color:#f97316;background:rgba(249,115,22,.08)}.muted{color:var(--muted)!important}.timeline{border-left:2px solid var(--line);padding-left:18px}.commentable{position:relative;border-radius:8px}.commentable:hover{outline:1px dashed rgba(138,162,255,.55);outline-offset:3px}.commented{background:rgba(138,162,255,.10)}.comments{position:sticky;top:94px;align-self:start;max-height:calc(100vh - 120px);overflow:auto;background:rgba(18,22,34,.92);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:var(--shadow)}.comments-head{display:flex;justify-content:space-between;align-items:center}.comments h2{margin:0}.hint{font-size:13px;color:var(--muted)}.comment{border-top:1px solid var(--line);padding:12px 0}.comment .type{color:var(--accent2);font-size:12px;text-transform:uppercase;font-weight:900}.comment .sel{font-size:12px;color:var(--muted);border-left:2px solid var(--line);padding-left:8px;margin:6px 0}#popover{position:fixed;right:380px;top:140px;width:320px;background:#0d1320;border:1px solid var(--line);border-radius:16px;padding:12px;z-index:20;box-shadow:var(--shadow)}#popover textarea,#popover select{width:100%;margin-bottom:8px;background:#090d16;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px}#popover textarea{min-height:100px}@media(max-width:980px){.shell{grid-template-columns:1fr}.comments{position:static}.review-header{align-items:flex-start;flex-direction:column}.two-col{grid-template-columns:1fr}}`;

const JS = `let comments=window.__PLAN__.comments||[], target=null;const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));function uid(){return 'cmt_'+Math.random().toString(36).slice(2)+Date.now().toString(36)}function markCommentables(){let i=0;$$('.agent-plan h1,.agent-plan h2,.agent-plan h3,.agent-plan p,.agent-plan li,.agent-plan td,.agent-plan th,.agent-plan blockquote,.agent-plan .card,.agent-plan .callout,.agent-plan .question,.agent-plan .decision,.agent-plan .risk,.agent-plan .step').forEach(el=>{if(!el.dataset.commentId)el.dataset.commentId='auto_'+(++i);el.classList.add('commentable');el.addEventListener('click',e=>{if(window.getSelection().toString().trim())return;target={id:el.dataset.commentId,text:''};showPopover(e.clientX,e.clientY)})})}function renderComments(){const ids=new Set(comments.filter(c=>!c.resolved).map(c=>c.targetId));$$('.commentable').forEach(e=>e.classList.toggle('commented',ids.has(e.dataset.commentId)));$('#commentList').innerHTML=comments.map(c=>'<div class="comment"><div class="type">'+esc(c.type||'comment')+'</div><div>'+esc(c.body)+'</div>'+(c.selectedText?'<div class="sel">“'+esc(c.selectedText)+'”</div>':'')+'<button class="secondary" onclick="resolveComment(\''+c.id+'\')">Resolve</button></div>').join('')||'<p class="hint">No comments yet.</p>'}function esc(s){return String(s||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}function showPopover(x,y){const p=$('#popover');p.hidden=false;p.style.top=Math.min(y+12,innerHeight-240)+'px';p.style.left=Math.min(x+12,innerWidth-360)+'px';$('#cbody').focus()}function hidePopover(){$('#popover').hidden=true;$('#cbody').value=''}async function save(){await fetch('/api/plans/'+window.__PLAN__.id+'/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(comments)})}window.resolveComment=async id=>{comments=comments.map(c=>c.id===id?{...c,resolved:true}:c);await save();renderComments()};document.addEventListener('mouseup',e=>{const sel=window.getSelection();const txt=sel.toString().trim();if(!txt)return;let node=sel.anchorNode&&sel.anchorNode.nodeType===3?sel.anchorNode.parentElement:sel.anchorNode;let el=node&&node.closest&&node.closest('.commentable');if(!el)return;target={id:el.dataset.commentId,text:txt};showPopover(e.clientX,e.clientY)});$('#saveComment').onclick=async()=>{const body=$('#cbody').value.trim();if(!body||!target)return;comments.unshift({id:uid(),targetId:target.id,selectedText:target.text,type:$('#ctype').value,body,createdAt:new Date().toISOString(),resolved:false});await save();hidePopover();renderComments()};$('#cancelComment').onclick=hidePopover;$('#addGeneral').onclick=e=>{target={id:'general',text:''};showPopover(e.clientX,e.clientY)};async function action(kind){await save();const r=await fetch('/api/plans/'+window.__PLAN__.id+'/'+kind,{method:'POST'});if(r.ok)alert(kind==='build'?'Build sent to pi. You can return to the terminal.':'Modify request sent to pi. You can return to the terminal.');else fallback(kind)}async function fallback(kind){const cmd='/html-plan '+kind+' '+window.__PLAN__.id;await navigator.clipboard.writeText(cmd);alert('Copied fallback command: '+cmd)}$('#modify').onclick=()=>action('modify');$('#build').onclick=()=>{const unresolved=comments.filter(c=>!c.resolved).length;if(confirm('Build with '+unresolved+' unresolved comment(s)?'))action('build')};$('#copyCmd').onclick=()=>fallback('modify');markCommentables();renderComments();`;
