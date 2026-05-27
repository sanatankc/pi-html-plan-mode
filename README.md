# pi-html-plan-mode

HTML plan mode for [pi](https://github.com/earendil-works/pi): the agent writes a flexible semantic HTML plan, while the extension provides the consistent review shell — header, browser comments, and `Modify Plan` / `Build` handoff.

This is intentionally **not** JSON-first and not markdown-first. The model owns the plan body:

```html
<main class="agent-plan">
  ...whatever structure best fits the task...
</main>
```

The extension owns the stable UX around it.

## Features

- `/html-plan <task>` starts read-only planning mode.
- Agent explores safely, then calls `save_html_plan` with HTML.
- Local browser review UI opens automatically.
- Click any line/card or select text to add Google Docs-style comments.
- Comments can be tagged as `decision`, `question-answer`, `change-request`, `concern`, etc.
- `Modify Plan` keeps plan mode active and asks the agent to revise the HTML plan.
- `Build` exits plan mode, restores tools, and asks the agent to implement the reviewed plan.
- Clipboard fallback copies short commands like `/html-plan build <plan-id>`.
- Plan storage can be project-local, global, or custom.

## Install

From GitHub:

```bash
pi install git:github.com/sanatankc/pi-html-plan-mode
```

From a local checkout:

```bash
pi install /path/to/pi-html-plan-mode
```

Or try without installing:

```bash
pi -e /path/to/pi-html-plan-mode
```

After install, restart pi or run `/reload`.

## Usage

Start a new plan:

```text
/html-plan add Fold ↔ Blinkit transaction matching
```

Force project-local storage:

```text
/html-plan --local add Fold ↔ Blinkit transaction matching
```

Force global/private storage:

```text
/html-plan --global investigate auth for a private API
```

Use a custom plans root:

```text
/html-plan --out ./docs/plans design the reconciliation algorithm
```

Open/list/re-enter actions:

```text
/html-plan list
/html-plan open <plan-id>
/html-plan modify <plan-id>
/html-plan build <plan-id>
```

## Storage

By default:

- inside a git repo: `.pi/plans/<plan-id>/`
- outside a git repo: `~/.pi/agent/html-plans/<plan-id>/`

Each plan directory contains:

```text
meta.json
plan.body.html      # agent-authored <main class="agent-plan">...</main>
plan.html           # generated browser review shell
comments.json
```

If you do not want local plans committed, add this to your repo `.gitignore`:

```gitignore
.pi/plans/
```

## Browser review flow

The generated review page has a consistent header and actions:

- **Modify Plan** — saves comments, keeps read-only plan mode enabled, and asks pi to revise the plan HTML only.
- **Build** — saves comments, exits plan mode, restores tools, and asks pi to implement the reviewed plan.
- **Copy Command** — fallback that copies a short command to paste into pi.

The buttons call a localhost server started by the extension.

## Agent HTML contract

The agent is instructed to return/call the save tool with exactly one body:

```html
<main class="agent-plan">
  ...
</main>
```

Rules:

- no full HTML document
- no scripts
- no external assets
- semantic HTML preferred: `section`, `article`, `h1-h3`, `p`, `ul`, `ol`, `table`, `blockquote`, `details`
- task-specific layout is encouraged

Optional theme classes available to the model:

- `card`
- `grid`
- `callout`
- `question`
- `decision`
- `risk`
- `step`
- `badge`
- `muted`
- `timeline`
- `two-col`

## Safety model

While in HTML plan mode:

- `edit` and `write` are blocked
- bash is restricted to a read-only allowlist
- the only write-like operation is the extension's `save_html_plan` tool, which writes plan artifacts

When you click **Build**, the extension exits plan mode and restores the previously active tools.

## Development

```bash
npm install
npm run typecheck
```

## License

MIT
