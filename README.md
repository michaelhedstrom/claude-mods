# Claude Code mods

Three mods for Claude Code: context-keeper, session-learner and progress.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-keeper --marketplace michaelhedstrom/claude-mods
/plugin install session-learner --marketplace michaelhedstrom/claude-mods
/plugin install progress --marketplace michaelhedstrom/claude-mods
```

From a shell:

```
claude plugin install context-keeper --marketplace michaelhedstrom/claude-mods
claude plugin install session-learner --marketplace michaelhedstrom/claude-mods
claude plugin install progress --marketplace michaelhedstrom/claude-mods
```

Answer `y` to "Add marketplace?", then choose a scope (user scope loads the mod in every session). A settings screen follows for any options. The mod is active immediately.

Desktop app: click + next to the prompt box → Plugins → Add marketplace `michaelhedstrom/claude-mods` → Add plugin.

## context-keeper

Keeps long sessions accurate across context compaction.

- **Note tool.** Claude records decisions, user corrections, constraints, verified results and open questions as short numbered notes while it works. Each prompt includes a reminder to do so.
- **Files touched.** Every file edited or written is listed in the ledger.
- **Earlier compaction.** The session compacts when the context reaches a set percentage of the window (default 50%) or a token cap (default 400k), whichever comes first. The summary follows a fixed checklist and includes the current git state.
- **Ledger after compaction.** The notes and file list are put back into the context word for word, so decisions and corrections are not lost in the summary.
- **Status line.** Shows context use, tokens left before compaction, and the number of notes.
- **`/ledgers [word]`** searches earlier sessions' ledgers; **`/ledgers load <id>`** copies an earlier session's notes into the current session. At session start, Claude is told about the 5 latest ledgers for the current project.

Options: compaction percentage (20–90), token cap, and whether to list recent ledgers at start.

Data: `~/.claude/context-keeper/<session-id>.json` and `<session-id>-summary.md`.

Model use: after each compaction, one Sonnet call merges the summary into the notes.

## session-learner

Learns how you prefer to work from your own messages and applies those preferences in every new session.

- Your messages (with keys, tokens and passwords removed) are collected during the session. After 15 messages, or after 10 minutes idle, a model call turns them into preference lines.
- A preference seen in two different sessions becomes a rule. An explicit instruction ("always…", "never…", "from now on…") becomes a rule at once. Candidates not seen again within 30 days are dropped.
- Rules are added to the system prompt of every new session. Your `~/.claude/CLAUDE.md` takes priority on conflicts, and rules it already covers are not added.
- About once a week the rule list is tidied: duplicates merged, conflicts resolved.
- **`/learned`** shows the file. You can edit or delete lines in it at any time.

Option: the model used for this (Haiku by default, or Sonnet).

Data: `~/.claude/session-learner/learned.md`.

Model use and privacy: each reflection sends your recent messages, the end of the assistant reply before each one, and the first 4,000 characters of your `~/.claude/CLAUDE.md` to the selected model.

## progress

A progress band above the prompt during multi-step work: the objective, a progress bar, the current step, and counts of tasks done and left.

- Claude updates the band through a `report` tool, and it also follows Claude Code's own task list.
- When a new list starts, a short Haiku call turns your prompt into an objective of up to 8 words, unless Claude has already given one.
- A finished list stays visible until your next prompt.

## Updates

Every push to this repository is a new version.

- **Automatic:** auto-update is off by default for this marketplace. To turn it on, run `/plugin`, open Marketplaces, select `michaelhedstrom-mods`, then select Enable auto-update. Claude Code then checks for new commits in the background after a session starts.
- **Manual:** run `/plugin marketplace update michaelhedstrom-mods` in a session, or `claude plugin update <mod>@michaelhedstrom-mods` from a shell, for example `claude plugin update context-keeper@michaelhedstrom-mods`.

Restart Claude Code after an update so the new version loads.

## Cost

All three mods make model calls through your own Claude Code account, so they count against your plan's usage or your API bill like any other request.

## Uninstall

```
/plugin uninstall context-keeper
/plugin uninstall session-learner
/plugin uninstall progress
```

## License

MIT
