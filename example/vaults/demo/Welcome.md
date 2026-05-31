---
tags: [demo]
---

# Welcome to the demo vault

This is a throwaway Obsidian vault used to demonstrate **Obsidian Guardian**.

A container is watching this folder. Whenever you change a file here, the
review note at [[Pending Review]] is regenerated to show exactly what changed
since the last *blessed* baseline.

## Try it

1. Edit any line in this note (or [[Ideas]]).
2. Open the `changes-*.md` note in the `_OG/` folder — your edit shows up as a
   pending change.
3. Bless or revert from the host with `pnpm og bless` / `pnpm og rollback`.
