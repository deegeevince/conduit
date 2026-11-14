# Sealed sets

`heldout.json` decides whether an experiment of the improvement loop is kept. The loop's critic and builder never see this folder: their worktrees are made without it, and a diff that touches `explore/` is refused. People may read it; do not tune the prompt, a technique or the painter against a prompt in it. When a held-out prompt has been used to make a decision by hand, move it to `../battery.json` and write a new one here.

The vault, a third set that catches a system learning this one by being selected on it, is not in the repository. The steward keeps it and runs it with `pnpm improve vault --file <path>`.

`../taste/` holds the owner's own scores of answers: the judge's agreement with them is printed by `pnpm taste`.
