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
| `aeroplane-b.json` | aeroplane (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `apple-b.json` | apple (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `baby-sitting-b.json` | baby, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `ball-b.json` | ball (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `bear-standing-b.json` | bear, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `bee-flying-b.json` | bee, flying (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `bicycle-b.json` | bicycle (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `bird-flying-b.json` | bird, flying (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `boat-b.json` | boat (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `book-b.json` | book (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `bus-b.json` | bus (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `butterfly-flying-b.json` | butterfly, flying (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `cake-b.json` | cake (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `car-b.json` | car (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `castle-b.json` | castle (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `cow-standing-b.json` | cow, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `dinosaur-standing-b.json` | dinosaur, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `dog-sitting-b.json` | dog, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `dragon-sitting-b.json` | dragon, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `duck-standing-b.json` | duck, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `elephant-standing-b.json` | elephant, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `fish-b.json` | fish (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `flower-b.json` | flower (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `frog-sitting-b.json` | frog, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `giraffe-standing-b.json` | giraffe, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `grandparent-sitting-b.json` | grandparent, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `hen-standing-b.json` | hen, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `horse-standing-b.json` | horse, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `lion-standing-b.json` | lion, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `mouse-sitting-b.json` | mouse, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `owl-sitting-b.json` | owl, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `pig-standing-b.json` | pig, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `rabbit-sitting-b.json` | rabbit, sitting (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `robot-standing-b.json` | robot, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `sheep-standing-b.json` | sheep, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `snail-b.json` | snail (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `teacher-standing-b.json` | teacher, standing (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `train-b.json` | train (`pnpm art fill`, art/common.txt) | fable | B | MIT |
| `turtle-walking-b.json` | turtle, walking (`pnpm art fill`, art/common.txt) | fable | B | MIT |

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
