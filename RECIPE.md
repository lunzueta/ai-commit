# Changes with AI commit message

![Changes with AI commit message](preview.png)

A Changes panel for Herdr: the staged-and-unstaged diff of the current repository, with a commit box. Next to the box are a model button and a sparkles button. The model button shows the active AI model and cycles through the models listed in `settings.json`. The sparkles button reads the staged diff (or, if nothing is staged, the diff against HEAD, which is what Commit stages anyway) and fills the commit box with one Conventional Commits subject line.

**What you see:** a card with a header ("Changes", file count, +/− totals), a file list (status letter, folder in grey, file name, added/removed counts), a diff viewer with line numbers and green/red rows, a note line for errors, and a footer with the commit box, the model button, the sparkles button and the Commit button. The model button is about 60 px wide and 32 px tall; the sparkles button is 32×32 px.

**How it behaves:**
- The file list and diff refresh on folder changes and every 10 seconds. Remote spaces run Git on their machine.
- Clicking a file shows its diff; clicking it again hides it. The first file is shown by default.
- Model button: click to switch to the next model. The choice is kept in shared state (`ai.model`).
- Sparkles button: while generating it spins and shows "AI: generating commit message…" in the note line. On success the subject appears in the commit box. On failure the note line shows the reason (missing key, HTTP status, empty reply, no repository).
- A commit already running blocks the sparkles button with "AI: a commit is in progress".
- Commit runs `git add -A` and then `git commit -m <message>`.

**Built from:**
- One mod, `mods/ai-commit/`: `main.js` (the panel), `mod.json` (`{"place": "none"}`: the layout decides where it goes), `sparkles.svg` (the icon, tinted with the text color).
- Shipped pieces used: the `changes` panel's structure (its diff parsing and list), and the `gpui-base` controls `InputState` and `Input`.
- `herdr` functions: `exec` (Git, with `on:` for remote spaces), `readTextFile` (reads `settings.json` in the app home), `appHome`, `watchFolder`, `theme`, `settings`, `shared` / `setShared`, `focused`, `spaces`, `panes`, `cx.spawn`, `cx.timer`.
- Commands: none. The mod never calls `run(...)`.
- Network: `fetch` to the endpoint of the model you pick: `https://api.anthropic.com/v1/messages` for `anthropic`, `<base_url>/chat/completions` for `openai` (default `https://api.openai.com/v1`), `<base_url>/api/chat` for `ollama` (default `http://127.0.0.1:11434`). The diff (up to 60,000 characters) is sent to that endpoint.
- Files read outside the mod folder: `<app home>/settings.json` (the `ai` section; it is read on every click and on each timer tick). It does not read any other file, and it does not write files.

**Configuration (`~/.config/herdr-app/settings.json`):**

```json
"ai": {
  "default": "Haiku",
  "models": [
    { "label": "Haiku",  "provider": "anthropic", "model": "claude-haiku-5-5", "api_key": "sk-ant-api03-..." },
    { "label": "Local",  "provider": "openai",    "model": "your-model-id", "base_url": "http://localhost:8000/v1", "api_key": "" },
    { "label": "Ollama", "provider": "ollama",    "model": "llama3.2" }
  ]
}
```

A single `{ "provider", "model", ... }` object without `models` also works.

**Watch out:**
- Anthropic requires a console API key (`api_key`). This mod does not read any other program's login or token.
- Keys in `settings.json` are stored in plain text. Don't commit that file.
- The subject should be ≤ 50 characters, but the model may go over; the box accepts any length. Edit it before committing if needed.
- The message is one line. The mod does not write a commit body.
- If you switch repositories while a message is generating, the message lands in the box of the repository you switched to. Wait for the note to clear first.
- Sending the diff to a third-party model means the code leaves your machine. Use `ollama` or an `openai`-compatible local server if that is not acceptable.
- The panel's layout and diff code come from Herdr's shipped `changes` mod, which is replaced on each start; this copy is independent.

**Done when:**
- `herdr-app check mods/ai-commit` passes.
- The model button shows the first model from `settings.json` ("Haiku" in the example) and changes to the next one when clicked.
- With a staged change in a repository, the sparkles button fills the commit box with a `type(scope): subject` line.
- With no key set for an `anthropic` model, the note line shows "no Anthropic API key".
- With nothing changed, the note line shows "no changes to summarize".
