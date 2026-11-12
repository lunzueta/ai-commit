# AI commit message

![AI commit message](preview.png)

A Changes panel for Herdr with an AI button for the commit message. It shows the uncommitted changes (staged, unstaged and untracked) with a file list and a diff viewer, and next to the commit box it has a model button and a sparkles button. The model button shows the active model and opens a menu of the models in `settings.json`. The sparkles button reads the diff and fills the commit box with one Conventional Commits subject line.

It is Herdr's shipped Changes panel (`mods/changes`) with the model button, the sparkles button and the AI code added, so it can replace that panel in a layout or sit beside it. `mod.json` says `{"place": "none"}`, so nothing docks by itself. Put it where the Changes panel goes in a layout:

```json
{ "id": "changes", "type": "block", "content": { "mod": "ai-commit" } }
```

`herdr-app do mod.open ai-commit` opens the same panel as a floating one, to try it before touching a layout (again closes it).

**What you see:** a card with a header ("Changes", file count, +/− totals), a file list (status letter, folder in grey, file name, added and removed counts), a diff viewer with line numbers and green/red rows, a note line for messages and errors, and a footer with the commit box, the model button, the sparkles button and the Commit button. The model button is 32 px tall and shows the model label (truncated to about 110 px). The sparkles button is 32×32 px. The model menu opens over the panel, above the footer, sized to the panel (300 px wide, at most 360 px tall, smaller in a small panel).

**How it behaves:**
- The file list and diff refresh when the folder changes and every 10 seconds (every 30 seconds on remote spaces, since each refresh runs Git over SSH). On a local folder a watch refreshes them sooner.
- Clicking a file shows its diff; clicking it again hides it. The first file is shown by default.
- Model button (the name with ▾, or Escape to close): opens a menu listing the models of every provider in `settings.json`, grouped by provider, with ✓ on the selected one. The lists come from each provider's API (see below) and are fetched when the menu is first opened. Clicking a model selects it for the sparkles button; the choice is kept in shared state (`ai-commit.selected`) and shown again when the panel opens.
- Sparkles button (or the keyboard command below): the button spins and the note line says "AI: generating commit message…". On success the subject appears in the commit box. If the subject is over 50 characters, the mod asks the model once more for a shorter one; if the result is still long, the note says how many characters it has. If the diff is over 60,000 characters, the note says it was truncated. A request that has not answered after 3 minutes is given up on (the note says so and the button works again); a reply that arrives later is dropped.
- Failures show a reason in the note line, in red: no configuration, missing key, HTTP status, empty reply, no repository, no changes. Informational notes (truncation, subject length) are shown in grey and disappear on the next file click or commit.
- If you switch repositories while a message is generating, the result is dropped.
- A commit already running blocks generation with "AI: a commit is in progress".
- Commit runs `git add -A` and then `git commit -m <message>`.

**Keyboard:** next to the mod, `keys.json` holds the key it expects:

```json
"mod:ai-commit": { "ctrl-alt-g": "ai-commit.generate" }
```

Merge that section into `~/.config/herdr-app/keys.json` (ask before replacing a key that is already used). The section name is the mod's folder name, so it has to be renamed if the folder is. Herdr delivers the command to the panel as `generate`.

**Built from:**
- One mod, `mods/ai-commit/`: `main.js` (the panel), `mod.json` (`"place": "none"` and an overlay, so nothing docks by itself and `mod.open` shows it floating) and `sparkles.svg` (the icon, tinted with the text color). Next to that folder there are `keys.json`, `RECIPE.md` and `preview.png`, and no `layouts/` folder.
- Built from the diff viewer and file list of Herdr's shipped `changes` panel, with the commit box, the model button and the AI button added.
- `herdr` functions: `exec` (Git with `on:` for remote spaces; `printenv`/`powershell` only to read an environment variable named in `api_key_env`; `pi` for the `pi` provider), `readTextFile` (reads `settings.json` in the app home, and a changed file's text for the preview and for the AI), `appHome`, `watchFolder`, `theme`, `settings`, `shared` / `setShared`, `nextCommand`, `focused`, `spaces`, `panes`, `cx.spawn`, `cx.timer`, `cx.focus_handle`.
- Commands: none. The mod never calls `run(...)`.
- Programs it runs: `git` (status, diff, add, commit; `git --no-optional-locks` with fsmonitor and index refresh off, so a refresh does not write under `.git` and wake the folder watch); `printenv` then `powershell` to read a key from the environment (`powershell` only where `printenv` is not there, such as Windows); `pi` for the `pi` provider (`pi --list-models` for the menu, `pi -p --no-session --no-tools --no-context-files --model … @<file>` to ask for the subject; on Windows, where `pi` is a `pi.cmd` shim that a direct spawn does not find, it retries `pi.cmd`).
- Network: `fetch` to the endpoint of the chosen model: `https://api.anthropic.com/v1/messages` for `anthropic`; `<base_url>/chat/completions` for `openai` (default `https://api.openai.com/v1`); `<base_url>/api/chat` for `ollama` (default `http://127.0.0.1:11434`); the model list from `/v1/models`, `<base_url>/models` or `/api/tags`. The diff (up to 60,000 characters) is sent to that endpoint. The `pi` provider reaches the network through `pi` itself.
- What the AI is sent: `git diff --staged` if anything is staged, else `git diff HEAD`, plus the untracked files as text (git diff leaves them out, but Commit adds them): the first 400 lines of each, 20,000 characters in all. Files it cannot read are listed by name only.
- Files read outside the mod folder: `<app home>/settings.json` (the `ai` section; read on every click and every timer tick) and files in the repository being previewed or summarized.
- Files written: only for the `pi` provider, `<app home>/data/ai-commit/request.txt` (the prompt and diff, deleted right after the run). Nothing else, and nothing in the repository.

**Configuration** (`~/.config/herdr-app/settings.json`):

```json
"ai": {
  "default": { "provider": "Anthropic", "model": "claude-haiku-5-5" },
  "providers": [
    { "name": "Pi", "provider": "pi" },
    { "name": "Anthropic", "provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY" },
    { "name": "Local server", "provider": "openai", "base_url": "http://localhost:8000/v1" },
    { "name": "Ollama", "provider": "ollama" },
    { "name": "Ollama cloud", "provider": "ollama", "base_url": "https://ollama.com", "api_key_env": "OLLAMA_API_KEY" }
  ]
}
```

- `provider` is the API: `anthropic`, `openai` (any OpenAI-compatible server: OpenAI, SGLang, vLLM, LM Studio…), `ollama`, or `pi`.
- The menu lists every model that the provider's API reports: Anthropic's `/v1/models`, `<base_url>/models` for `openai`, and Ollama's local model list (embedding models are left out). `pi` lists `pi --list-models` as `provider/model`, so a model is written `anthropic/claude-haiku-5-5`.
- Ollama lists the models installed on that server (`/api/tags`). For the Ollama cloud catalog, add a second provider with `"base_url": "https://ollama.com"` and an `api_key_env` (chat with the cloud needs a key from ollama.com).
- `pi` needs nothing but `pi` on `PATH`: it runs the same models and the same logins `pi` already has, so no key goes in `settings.json`. It is the one provider that uses another program's login.
- To fix the model of a provider instead of listing them, add `"model": "…"` to it; it then shows as the only entry.
- Keys: `api_key` (in the file) or `api_key_env` (an environment variable name; the file then holds no secret). `ollama` needs none; `openai`-compatible servers take an optional key.
- Anthropic needs a console API key. Apart from the `pi` provider, the mod uses no other program's login or token.
- Older files with `"models": [{label, provider, model}]` still work.

**Watch out:**
- Keys in `settings.json` are plain text. Prefer `api_key_env`, and don't commit that file.
- The `pi` provider is the one that runs another program: `pi` must be installed and logged in, and the diff is written to `data/ai-commit/request.txt` (in the app home) for the length of the run, then deleted. A crash or a kill during the run can leave that file behind.
- The model may still return a subject longer than 50 characters after the retry. The note says so; edit it before committing if needed.
- The subject is one line. The mod does not write a commit body; write the body yourself if you need one.
- Sending the diff to a third-party model means the code leaves your machine. Use `ollama`, a local `openai`-compatible server or `pi` with a local model if that is not acceptable. This includes untracked files, which are sent as text.
- A provider whose key is missing is reported inside its block in the model menu ("environment variable ANTHROPIC_API_KEY is not set", or "no Anthropic API key"), in red. That is configuration, not a crash: the other providers still list their models, and a provider with `"model": "…"` never asks for a list. The mod never reuses another program's credentials for a plain API provider; only the `pi` provider uses pi's logins, because it runs pi itself.
- The catalog is fetched once per panel session: a provider that failed keeps its message until the panel is closed and opened again (or the app restarts).
- A hung endpoint is only abandoned after 3 minutes; there is no cancel button.
- Reasoning models (for example Qwen through SGLang) can put their reasoning in a separate field. The mod uses only the text reply.
- The panel is a copy of the Changes panel, so a layout that already has `changes` shows two panels unless one is removed or the block points at this mod instead.
- The model menu is drawn inside the panel, so it never grows beyond it: in a short panel it is short, and it scrolls with the wheel. Escape closes it.

**Done when:**
- `herdr-app check mods/ai-commit` passes.
- The model button shows the default model from `settings.json`; its menu lists models from each configured provider and the chosen one gets ✓.
- Clicking a file in the list shows that file's diff (the list still works with the model menu present).
- With a staged change, the sparkles button fills the commit box with a `type(scope): subject` line.
- With only untracked files, it still fills the box (they are part of the diff it reads).
- With nothing changed, the note line says "no changes to summarize".
- With an `anthropic` model and no key, the note line says "no Anthropic API key".
- With a subject over 50 characters, the mod asks again and the note shows the length if it is still over.
- The keyboard command generates the same message as the button.
