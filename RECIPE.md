# AI commit message

![AI commit message](preview.png)

A Changes panel for Herdr with an AI button for the commit message. It shows the staged diff (or, if nothing is staged, the diff against HEAD, which is what Commit stages anyway) with a file list and a diff viewer. Next to the commit box it has a model button and a sparkles button. The model button shows the active model and cycles through the models in `settings.json`. The sparkles button reads the diff and fills the commit box with one Conventional Commits subject line.

**What you see:** a card with a header ("Changes", file count, +/− totals), a file list (status letter, folder in grey, file name, added and removed counts), a diff viewer with line numbers and green/red rows, a note line for messages and errors, and a footer with the commit box, the model button, the sparkles button and the Commit button. The model button is 32 px tall and shows the model label (truncated to about 96 px). The sparkles button is 32×32 px.

**How it behaves:**
- The file list and diff refresh when the folder changes and every 10 seconds (every 30 seconds on remote spaces, since each refresh runs Git over SSH).
- Clicking a file shows its diff; clicking it again hides it. The first file is shown by default.
- Model button: click to switch to the next model in `settings.json`. The choice is kept in shared state (`ai.model`) and shown again when the panel opens.
- Sparkles button (or the keyboard command below): the button spins and the note line says "AI: generating commit message…". On success the subject appears in the commit box. If the subject is over 50 characters, the mod asks the model once more for a shorter one; if the result is still long, the note says how many characters it has. If the diff is over 60,000 characters, the note says it was truncated.
- Failures show a reason in the note line: no configuration, missing key, HTTP status, empty reply, no repository.
- If you switch repositories while a message is generating, the result is dropped.
- A commit already running blocks generation with "AI: a commit is in progress".
- Commit runs `git add -A` and then `git commit -m <message>`.

**Keyboard:** add this to `keys.json` to generate with `ctrl-alt-g` (any free key works):

```json
"mod:ai-commit": { "ctrl-alt-g": "ai-commit.generate" }
```

**Built from:**
- One mod, `mods/ai-commit/`: `main.js` (the panel), `mod.json` (`{"place": "none"}`: the layout decides where it goes), `sparkles.svg` (the icon, tinted with the text color), and `preview.png`.
- Built from the diff viewer and file list of Herdr's shipped `changes` panel, with the commit box and AI button added.
- `herdr` functions: `exec` (Git with `on:` for remote spaces; `printenv`/`powershell` only to read an environment variable named in `api_key_env`), `readTextFile` (reads `settings.json` in the app home), `appHome`, `watchFolder`, `theme`, `settings`, `shared` / `setShared`, `nextCommand`, `focused`, `spaces`, `panes`, `cx.spawn`, `cx.timer`.
- Commands: none. The mod never calls `run(...)`.
- Network: `fetch` to the endpoint of the chosen model: `https://api.anthropic.com/v1/messages` for `anthropic`; `<base_url>/chat/completions` for `openai` (default `https://api.openai.com/v1`); `<base_url>/api/chat` for `ollama` (default `http://127.0.0.1:11434`). The diff (up to 60,000 characters) is sent to that endpoint.
- Files read outside the mod folder: `<app home>/settings.json` (the `ai` section; read on every click and every timer tick). The mod writes no files.

**Configuration** (`~/.config/herdr-app/settings.json`):

```json
"ai": {
  "default": "Local",
  "models": [
    { "label": "Haiku",  "provider": "anthropic", "model": "claude-haiku-5-5", "api_key_env": "ANTHROPIC_API_KEY" },
    { "label": "Local",  "provider": "openai",    "model": "your-model-id", "base_url": "http://localhost:8000/v1" },
    { "label": "Ollama", "provider": "ollama",    "model": "llama3.2" }
  ]
}
```

- `api_key` (in the file) or `api_key_env` (name of an environment variable; the file then holds no secret) for `anthropic`. `openai`-compatible servers take an optional `api_key` the same way. `ollama` needs none.
- A single `{ "provider", "model", ... }` object without `models` also works.
- Anthropic needs a console API key. This mod does not use any other program's login or token.

**Watch out:**
- Keys in `settings.json` are plain text. Prefer `api_key_env`, and don't commit that file.
- The model may still return a subject longer than 50 characters after the retry. The note says so; edit it before committing if needed.
- The subject is one line. The mod does not write a commit body; write the body yourself if you need one.
- Sending the diff to a third-party model means the code leaves your machine. Use `ollama` or a local `openai`-compatible server if that is not acceptable.
- Reasoning models (for example Qwen through SGLang) can put their reasoning in a separate field. The mod uses only the text reply.
- The keyboard command depends on Herdr delivering `nextCommand()` names without the mod prefix; check it once in your setup.

**Done when:**
- `herdr-app check mods/ai-commit` passes.
- The model button shows the default model from `settings.json` and changes to the next one when clicked.
- With a staged change, the sparkles button fills the commit box with a `type(scope): subject` line.
- With nothing changed, the note line says "no changes to summarize".
- With an `anthropic` model and no key, the note line says "no Anthropic API key".
- With a subject over 50 characters, the mod asks again and the note shows the length if it is still over.
- The keyboard command generates the same message as the button.
