# Art on the shelf: where each sheet came from

`art/seed/*.json` are the sheets that ship with the repository (PLAN-art.md, section 6). A sheet holds Series part lines, never SVG, and carries its own
`made` and `licence` fields; this file lists them in one place.

## The seeds

Every seed was drawn by Fable (a model) for this project, off the answer's clock, on the owner's own subscription, in the art bake-off
(`pnpm bakeoff`, arms B and D), and then read by the strict converter (`server/src/art/svg.ts`) and restyled to the house palette
(`server/src/art/palette.ts`) by `pnpm art import`. They are original drawings, not copies of anything. Their licence is the repository's: MIT.

| Sheet | Subject, pose | Made | Arm | Licence |
| --- | --- | --- | --- | --- |
| `fox-sitting-b.json`, `fox-sitting-d.json` | fox, sitting, facing left | fable | B one careful drawing, D staged | MIT |
| `monster-standing-b.json`, `monster-standing-d.json` | a friendly woodland monster (original, not a named character), standing | fable | B, D | MIT |
| `house-b.json`, `house-d.json` | house, front | fable | B, D | MIT |
| `child-standing-b.json`, `child-standing-d.json` | child, standing | fable | B, D | MIT |
| `rocket-b.json`, `rocket-d.json` | rocket | fable | B, D | MIT |
| `oak-tree-b.json`, `oak-tree-d.json` | oak tree | fable | B, D | MIT |
| `cat-sitting-b.json` | cat, sitting, facing left (the first sheet of `pnpm art fill`) | fable | B | MIT |

The bake-off's heart cutaway is not on the shelf: diagrams stay with the brain's diagram tools.

## Adding a sheet

`pnpm art fill --into seed` commissions the subjects of `art/common.txt` that the shelf lacks, through the studio's own path, and writes each sheet here as `made: fable`, MIT; add a row for it above. `--dry-run` projects the time and cost first.

```
pnpm art import /path/to/drawing.svg --subject "red panda" --pose sitting --view side --facing left --arm B --by fable
pnpm art check
pnpm art shots --subject "red-panda" --look paper,night,blueprint --out /tmp/shots   # look at it before keeping it
```

Only art with a licence that allows it in this repository (CC0, MIT, Apache 2.0, or made for the project) goes in `art/seed/`; say so in the sheet's
`licence` and add a row above. Art under a share-alike or attribution licence stays out (PLAN-art.md, "Seeds, with licences checked").
