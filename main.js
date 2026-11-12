import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, appHome, home, shared, setShared, nextCommand } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.generating = false; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    this.loadModelLabel(cx);
    // Local: refresh every 10 s. Remote: every 30 s, since each refresh runs Git over SSH.
    this.ticks = 0;
    cx.timer.every(10000, (cx) => { this.ticks++; if (!this.on || this.ticks % 3 === 0) this.refresh(cx); this.loadModelLabel(cx); });
    // Keyboard: keys.json → "mod:ai-commit": { "ctrl-alt-g": "ai-commit.generate" }
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "generate") this.generateMessage(cx); cx.notify(); } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // settings() only exposes the app's look and zoom/sounds, not the raw file,
  // so the ai section is read straight from settings.json in the app home.
  // settings.json → "ai": { "default": {"provider", "model"}, "providers": [ { "name", "provider", "base_url"?, "api_key"?, "api_key_env"?, "model"? } ] }
  // Without "model", a provider's models are listed from its API (Anthropic, OpenAI-compatible, Ollama).
  // The old format ("models": [{label, provider, model}] or one object) still works.
  async readAiConfig() {
    const text = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
    if (!text) return null;
    let ai;
    try { ai = JSON.parse(text).ai; } catch { return null; }
    if (!ai) return null;
    let providers = Array.isArray(ai.providers)
      ? ai.providers
      : (Array.isArray(ai.models) ? ai.models : [ai]).filter((m) => m && m.model).map((m) => ({ ...m, model: m.model }));
    providers = providers.filter((p) => p && p.provider).map((p) => ({ ...p, name: p.name ?? p.label ?? p.provider }));
    if (!providers.length) return null;
    // The choice from the menu (shared state) wins over settings.json's default.
    let selected = null;
    try {
      const stored = JSON.parse(shared("ai.selected") ?? "null");
      if (stored && providers.some((p) => p.name === stored.provider)) selected = { provider: stored.provider, model: stored.model ?? null };
    } catch {}
    const d = ai.default;
    if (!selected && d && typeof d === "object" && providers.some((p) => p.name === d.provider)) selected = { provider: d.provider, model: d.model ?? null };
    if (!selected && typeof d === "string" && providers.some((p) => p.name === d)) selected = { provider: d, model: providers.find((p) => p.name === d).model ?? null };
    if (!selected) selected = { provider: providers[0].name, model: providers[0].model ?? null };
    return { providers, selected };
  }

  // Asks the AI configured in settings.json for one Conventional Commits subject line
  // for the staged diff (or the diff against HEAD when nothing is staged), and fills the box.
  generateMessage(cx) {
    if (this.generating) return;
    if (!this.root) { this.note = "AI: no repository loaded yet"; cx.notify(); return; }
    if (this.busy) { this.note = "AI: a commit is in progress"; cx.notify(); return; }
    const root = this.root, on = this.on;
    this.generating = true; this.note = "AI: generating commit message…";
    cx.spawn(async (cx) => {
      try {
        const cfg = await this.readAiConfig();
        if (!cfg) throw new Error('no AI configured: set settings.json → "ai": {"models": [{"label": "…", "provider": "anthropic"|"openai"|"ollama", "model": "…"}]}');
        const p = cfg.providers.find((x) => x.name === cfg.selected.provider);
        const model = cfg.selected.model;
        if (!p || !model) throw new Error("no model selected: open the model menu next to the sparkles button");
        const ai = { ...p, model };
        const { diff, truncated } = await this.readDiff(root, on);
        let subject = await this.askAi(ai, diff);
        // The model does not always respect the length limit: ask once more for a shorter one.
        if (subject.length > 50) {
          const shorter = await this.askAi(ai, diff, `Your previous answer was ${subject.length} characters. Reply with a shorter subject, at most 50 characters.`).catch(() => "");
          if (shorter) subject = shorter;
        }
        // The repository may have changed while the model was answering: drop the result then.
        if (this.root !== root) return;
        if (!subject) { this.note = "AI returned an empty message"; return; }
        this.input.set_value(subject); this.message = subject;
        const notes = [];
        if (truncated) notes.push("Diff truncated to 60,000 characters for the AI.");
        if (subject.length > 50) notes.push(`Subject is ${subject.length} characters (50 recommended).`);
        this.note = notes.length ? notes.join(" ") : null;
      } catch (e) { if (this.root === root) this.note = `AI commit message failed: ${e}`; }
      finally { this.generating = false; cx.notify(); }
    });
    cx.notify();
  }

  // Staged diff; if nothing is staged, the diff against HEAD (what Commit will stage with git add -A).
  async readDiff(root, on) {
    const r = await exec("git", [...READ, "diff", "--staged", "--no-color"], { cwd: root, on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git diff --staged failed");
    let diff = r.stdout.trim();
    if (!diff) {
      const w = await exec("git", [...READ, "diff", "HEAD", "--no-color"], { cwd: root, on });
      if (w.code !== 0) throw new Error((w.stderr || w.stdout).trim() || "git diff HEAD failed");
      diff = w.stdout.trim();
    }
    if (!diff) throw new Error("no changes to summarize (nothing staged or modified)");
    const LIMIT = 60000;
    return { diff: diff.slice(0, LIMIT), truncated: diff.length > LIMIT };
  }

  // The API key for a model: "api_key" in settings.json, or the environment variable named by "api_key_env".
  async apiKey(ai) {
    if (ai.api_key) return ai.api_key;
    if (!ai.api_key_env) return "";
    const name = String(ai.api_key_env);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid api_key_env name: ${name}`);
    const unix = await exec("printenv", [name]).catch(() => null);
    if (unix?.code === 0 && unix.stdout.trim()) return unix.stdout.trim();
    const win = await exec("powershell", ["-NoProfile", "-Command", `$v=[Environment]::GetEnvironmentVariable('${name}','User'); if(-not $v){$v=[Environment]::GetEnvironmentVariable('${name}','Machine')}; if(-not $v){$v=$env:${name}}; Write-Output $v`]).catch(() => null);
    if (win?.code === 0 && win.stdout.trim()) return win.stdout.trim();
    throw new Error(`environment variable ${name} is not set`);
  }

  // One subject line from the chosen model. retryHint is appended when the previous answer was too long.
  async askAi(ai, diff, retryHint) {
    const system = "You write git commit messages. Reply with only one line: the commit subject. No body, no quotes, no explanation, no markdown.";
    const user = `Write one Conventional Commits subject line for these changes.\nFormat: type(scope): subject\n- type: fix for corrections, feat only for new behavior, refactor, test, docs, chore as appropriate.\n- imperative mood, lowercase subject, no trailing period, at most 50 characters in total.\n- describe the change, not its results or metrics.${retryHint ? `\n- ${retryHint}` : ""}\n\n${diff}`;
    const raw = await this.callModel(ai, system, user);
    // First non-empty line, without quotes, backticks or a trailing period.
    const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return line.replace(/^[\"'`]+|[\"'`]+$/g, "").replace(/\.$/, "").trim();
  }

  async callModel(ai, system, user) {
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    if (ai.provider === "anthropic") {
      const key = await this.apiKey(ai);
      if (!key) throw new Error('no Anthropic API key: set "api_key" or "api_key_env" for this model in settings.json');
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
        body: JSON.stringify({ model: ai.model, max_tokens: 512, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text.trim()) throw new Error(`no text in reply (stop_reason=${data.stop_reason})`);
      return text;
    }
    if (ai.provider === "openai") {
      const key = await this.apiKey(ai);
      const base = String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: ai.model, messages, max_tokens: 512 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    // Default: Ollama. A local server needs no key; ollama.com (cloud) needs one.
    const base = String(ai.base_url || "http://127.0.0.1:11434").replace(/\/$/, "");
    const key = await this.apiKey(ai);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: ai.model, messages, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.message?.content ?? "";
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // The model name on the button. Re-read on every timer tick, so edits to settings.json show up.
  loadModelLabel(cx) {
    cx.spawn(async (cx) => {
      const cfg = await this.readAiConfig();
      this.providers = cfg?.providers ?? [];
      this.selected = cfg?.selected ?? null;
      const label = this.selected?.model ?? null;
      if (label !== this.modelName) { this.modelName = label; cx.notify(); }
    });
  }

  modelLabel() {
    return this.modelName ?? "Choose model";
  }

  toggleMenu(cx) {
    this.menuOpen = !this.menuOpen;
    if (this.menuOpen) cx.spawn(async (cx) => { await this.loadCatalog(); cx.notify(); });
    cx.notify();
  }

  // Lists each provider's models once per session; errors are shown in the menu.
  async loadCatalog() {
    const cfg = await this.readAiConfig();
    if (!cfg) return;
    this.providers = cfg.providers; this.selected = cfg.selected;
    this.catalog = this.catalog ?? {};
    for (const p of cfg.providers) {
      if (this.catalog[p.name]) continue;
      try { this.catalog[p.name] = { models: await this.fetchModels(p) }; }
      catch (e) { this.catalog[p.name] = { error: String(e).slice(0, 160) }; }
    }
  }

  async fetchModels(p) {
    if (p.model) return [p.model];
    const base = (u) => String(u).replace(/\/$/, "");
    if (p.provider === "anthropic") {
      const key = await this.apiKey(p);
      if (!key) throw new Error('no API key (set "api_key" or "api_key_env")');
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "anthropic-version": "2023-06-01", "x-api-key": key } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).data ?? []).map((m) => m.id);
    }
    if (p.provider === "openai") {
      const key = await this.apiKey(p);
      const res = await fetch(`${base(p.base_url || "https://api.openai.com/v1")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).data ?? []).map((m) => m.id);
    }
    if (p.provider === "ollama") {
      // The list needs no key; a key (for ollama.com) is sent when one is configured.
      const key = await this.apiKey(p).catch(() => "");
      const res = await fetch(`${base(p.base_url || "http://127.0.0.1:11434")}/api/tags`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Embedding models can't write messages: leave them out.
      return ((await res.json()).models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    }
    throw new Error(`unknown provider "${p.provider}"`);
  }

  pick(provider, model, cx) {
    setShared("ai.selected", JSON.stringify({ provider, model }));
    this.selected = { provider, model };
    this.modelName = model;
    this.menuOpen = false;
    cx.notify();
  }

  modelMenu(t) {
    const rows = [];
    for (const p of this.providers ?? []) {
      rows.push(div().px(10).pt(8).pb(2).text_size(10).text_color(t.dim).font_semibold().child(p.name.toUpperCase()));
      const entry = this.catalog?.[p.name];
      if (!entry) rows.push(div().px(10).py(4).text_size(11).text_color(t.dim).child("loading…"));
      else if (entry.error) rows.push(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(entry.error));
      else if (!entry.models.length) rows.push(div().px(10).py(4).text_size(11).text_color(t.dim).child("no models"));
      else for (const m of entry.models) {
        const on = this.selected?.provider === p.name && this.selected?.model === m;
        rows.push(h_flex().id(`model-${p.name}-${m}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).when(on, (e) => e.bg(t.selected))
          .on_click((_e, cx) => this.pick(p.name, m, cx))
          .child(div().w(12).text_color(t.accent).child(on ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().child(m)));
      }
    }
    return v_flex().id("model-menu").absolute().right(10).bottom(54).w(300).max_h(360).overflow_y_scroll().py(4).rounded(8).border_1().border_color(t.border).bg(t.popover).children(rows);
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().relative().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.menuOpen, (e) => e.child(this.modelMenu(t)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("commit-model").h(32).px(10).gap(6).items_center().rounded(8).border_1().border_color(this.menuOpen ? t.accent : t.border).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Model for commit messages: click to choose")
          .on_click((_e, cx) => this.toggleMenu(cx))
          .child(div().max_w(110).truncate().child(this.modelLabel())).child(div().text_size(9).child("▾")))
        .child(div().id("commit-ai").h(32).w(32).flex().items_center().justify_center().rounded(8).border_1().border_color(this.generating ? t.accent : t.border).text_color(this.generating ? t.accent : t.muted).tooltip("Generate commit message from staged changes with AI")
          .when(!this.generating, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => this.generateMessage(cx))
          .child(this.generating ? svg("mods/ai-commit/sparkles.svg").size(15).spin(900) : svg("mods/ai-commit/sparkles.svg").size(15)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
