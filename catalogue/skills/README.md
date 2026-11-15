# Made-up skills for tests

Every skill here is invented. Test servers point `SKILL_ROOTS` and `SKILL_SETTINGS` at this folder so that no test ever reads the owner's own skills:

    SKILL_ROOTS=user=<repo>/catalogue/skills/user,synced=<repo>/catalogue/skills/synced SKILL_SETTINGS=<repo>/catalogue/skills/settings.json

`plain-words`, `ledger` and `slides` end with a marker line the checks can find. `big` is about 30 KB with headings, to test the cut. `hostile` and
`secretive` are for the rules (SK2 and later). `shared-name` is in both sources (the user's wins), `twin` is in two synced accounts with the same words
(one entry), `retired` is switched off by `settings.json`, and `screen-driver` is about a tool this app does not have.
