# Sealed sets

Nothing is sealed in this folder any more. v2's held-out file lived here from the first commit, beside the tune set, and the prompt's own examples were written after it; it was never held out. It is now `../tune-b.json`, a second tune set that anyone may read and tune against.

The held-out set of v2.1 is written fresh by `pnpm explore --write-heldout`: a cold `claude -p` writer that is given only the definitions of the families and how many prompts each needs (no seeds, no tune set, no tools, an empty working folder). It is saved to `$BATTERY_SEALED_DIR/heldout.json`, a folder outside the repository, mode 600, and the tool prints counts, never prompts. `pnpm explore --pool heldout` reads only that file and refuses to run when `BATTERY_SEALED_DIR` is not set.

It decides whether an experiment of the improvement loop is kept. The loop's critic and builder never see it: their worktrees are made without it, and a diff that touches `explore/` is refused. Do not tune the prompt, a technique or the painter against a prompt in it. When a held-out prompt has been used to make a decision by hand, the set is spent: move it to `../tune-b.json`'s side and write a new one (`--write-heldout --yes`).

The vault, a third set that catches a system learning this one by being selected on it, is not in the repository. The steward keeps it and runs it with `pnpm improve vault --file <path>`.

`../taste/` holds the owner's own scores of answers: the judge's agreement with them is printed by `pnpm taste`.
