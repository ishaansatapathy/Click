# Gate G2: does Click's context reach Claude Code?

Goal (max 30 minutes): prove that when you type a task in Claude Code, a `<click_context>` block arrives with it, in
(a) the Claude Code CLI and (b) the Claude Code VS Code extension. Whatever you find, write it down; both outcomes are fine.
If the extension does not run hooks, the MCP path (prompts 170/174) covers it.

All commands run from the Click repo root (`C:\Users\IshaanSatapathy\Desktop\Cllick`). `bench\repo` is the Vue repo
(v3-admin-vite) the benchmark uses. Everything below was rehearsed by Claude on a throwaway clone of it: the first prompt
starts the daemon, the second gets about 9.7k characters of context in ~130 ms.

## 0. What is already done

- Click is built in the Click repo (`pnpm install` and `pnpm build` ran; `packages\click\dist\...` exists).
- HydraDB is running in Docker (`click-hydradb-node` healthy).
- OpenAI key: **optional**. Without `OPENAI_API_KEY` the semantic part is off (`degraded: semantic-off`), the rest works.
  To turn it on, set it in the terminal that runs the daemon: PowerShell `$env:OPENAI_API_KEY = "sk-..."`.

If you pulled new code since, run `pnpm install; pnpm build` again first.

## 1. Install the hook into the bench repo

```powershell
cd C:\Users\IshaanSatapathy\Desktop\Cllick
node packages\click\dist\click.js hooks install --local --git --root bench\repo
node packages\click\dist\click.js hooks status --root bench\repo
```

- `--local` writes `bench\repo\.claude\settings.local.json` (Claude Code keeps it out of git). The command inside is
  `node "C:/.../packages/click/dist/hooks/prompt.js"`.
- `--git` also adds a git post-commit hook (re-indexes after commits). It is harmless, and it is what 118 built.
- `status` must show a `UserPromptSubmit` line and `.click directory: present`.

## 2. Start the daemon and check it without Claude

Open a **second terminal** and leave it running:

```powershell
cd C:\Users\IshaanSatapathy\Desktop\Cllick
node packages\click\dist\click.js serve --root bench\repo
```

Back in the first terminal:

```powershell
node packages\click\dist\click.js status --root bench\repo
node packages\click\dist\click.js context "When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen." --root bench\repo
```

- `status` should say `ready` (the first boot takes ~7 s) and `hydradb: ok`.
- `context` should print a `<click_context ...>` block with `src/pinia/stores/user.ts`, `src/router/index.ts`, and so on.
  If this does not work, stop here and tell Claude: nothing else will work either.

(If you skip this step, the hook starts the daemon itself on the first prompt. That first prompt gets **no** context,
because the daemon needs a few seconds to load. That is by design: the agent is never made to wait.)

Test the hook by hand too, with the exact payload Claude Code sends (one line):

```powershell
'{"hook_event_name":"UserPromptSubmit","session_id":"manual","cwd":"C:\\Users\\IshaanSatapathy\\Desktop\\Cllick\\bench\\repo","prompt":"When a user logs out clear every piece of session state and return to sign in"}' | node packages\click\dist\hooks\prompt.js
```

It must print one JSON line starting with `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<click_context`.

## 3. Claude Code CLI

```powershell
cd C:\Users\IshaanSatapathy\Desktop\Cllick\bench\repo
claude
```

1. Type `/hooks`. You should see a `UserPromptSubmit` hook from the local settings that runs `prompt.js`.
   (If Claude Code asks you to trust the project or approve the hook, approve it.)
2. Give it a task (no leading `/`, at least 4 words). Use this one:

   > When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen.

3. Watch what the agent does first. With Click it should go straight to `src/pinia/stores/user.ts`, `tags-view.ts`,
   `src/router/index.ts` (`resetRouter`) without a long search. Without Click it greps around first.
4. After it answers, ask: **"Did you receive a `<click_context>` block with my previous message? Quote its first line."**
   It should quote something like `<click_context version="1" tokens="2766" budget="4000" items="6" graph="e154959" ...>`.

### Evidence that does not depend on what the agent says

```powershell
# the hook's own log: one line per prompt (never contains your prompt)
Get-Content bench\repo\.click\logs\hook-*.jsonl -Tail 5
# the daemon's log of what it served; look for "source":"hook"
Get-Content bench\repo\.click\contexts.jsonl -Tail 1
node packages\click\dist\click.js status --root bench\repo
# Claude Code's own transcript: did the block land in the conversation?
Select-String -Path "$env:USERPROFILE\.claude\projects\*\*.jsonl" -Pattern "click_context" -List | Select-Object -First 3 Path
```

Good result: hook log says `"outcome":"delivered"`, `contexts.jsonl` has a `"source":"hook"` line, and the transcript
contains `click_context`.

## 4. Claude Code VS Code extension

1. **Close** any Claude Code session in that folder (hooks are read when a session starts).
2. In VS Code: open the folder `C:\Users\IshaanSatapathy\Desktop\Cllick\bench\repo`, open the Claude Code panel, start a **new** conversation.
3. Send the same task. Then ask the same "did you receive a `<click_context>` block?" question.
4. Run the same evidence commands as above. New lines in `hook-*.jsonl` after you sent the prompt from VS Code mean the
   extension ran the hook. **No new line = the extension did not run it.**

## 5. If something is off

| What you see | Meaning | Do |
|---|---|---|
| no new line in `hook-*.jsonl` at all | Claude Code did not run the hook | `/hooks` shows nothing: re-run step 1, restart Claude Code. Nothing in `/hooks` but settings file is right: tell Claude, this is the extension/CLI finding to record |
| `skip:not-a-click-repo` | wrong folder (no `.click` there) | open the session in `bench\repo` itself |
| `skip:short` / `slash-command` / `noclick` | prompt not eligible | use a longer prompt that does not start with `/` |
| `no-context:daemon` | daemon was not up (the first prompt starts it) | wait 10 s, send again; or do step 2 first |
| `no-context:warming` | daemon still loading | wait, send again |
| `no-context:too-long` | context over 10,000 chars | tell Claude (should not happen: the daemon is asked for at most 9,800) |
| `delivered` but the agent says it saw nothing | hook ran, Claude Code did not show it to the model | record it exactly like that; MCP covers this case |

More detail on any failure: set `CLICK_DEBUG=1` in the environment before starting `claude` (reasons go to stderr and to
`.click\logs`).

## 6. Tell Claude the result

Copy this and fill in:

```
G2 result
CLI:       hook ran: yes/no | outcome in hook log: ... | agent quoted the block: yes/no | transcript has click_context: yes/no
Extension: hook ran: yes/no | outcome in hook log: ... | agent quoted the block: yes/no | transcript has click_context: yes/no
Notes: (anything odd: approval prompts, delays, errors shown)
```

Claude records it in DECISIONS and opens gate G2.

## 7. Clean up (optional)

```powershell
node packages\click\dist\click.js hooks uninstall --local --git --root bench\repo
```

Stop the daemon with Ctrl+C in its terminal (it also stops itself after 4 idle hours).
