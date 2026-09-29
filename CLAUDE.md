@AGENTS.md

## Claude Code specifics

- The desktop app creates the worktree branch for you; bring it up to date with `main` via the `sync_with_base_branch` tool, not a manual `git merge`/`git pull`.
- ChatCut Desktop is shared across sessions: before any `chatcut_desktop` call take the lock (`mkdir ~/.cache/autocrew-yt/chatcut.lock`), release it when the stage ends or before asking the founder, and pass explicit track/item IDs on writes.
