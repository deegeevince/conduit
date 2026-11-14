# Review a document clause by clause

summary: Review a contract, a lease, an agreement or a policy with me, go through it clause by clause, what does this clause mean, flag the risks and red flags, let me decide on each one.
reason: only if the person is to go through a document part by part and make a call on each

Writes the review as a document of parts: a part for each clause or section, a choice for each that is the person's call, and help that says what it means.

**Use it when** the person brings a document to be gone through, and the calls are theirs. One `part` for the document and one for each clause or section, titled as the document words it (the clause's own words, with `crop=` when it is a photo; unreadable: say so in the title, with "?"). Each part is an `ask <id> check=any pick=Fine,Question,Escalate | <what the clause says, in one line>`: a choice with no right answer, which opens the next part once made. Help for an ask is its own parts, `for=<ask>`, each a `tag=` word and a short plain-words account: what it means, what to ask for instead. Say only what the document says; when it does not say, say so; never give a legal conclusion as a sealed answer. A part that cannot be read or checked reliably says so in its title and is for a person to check. Write the first clause now and the rest as the person reaches them. Finish with a `reply` of the calls made.

**Not when** the person wants the document summarised (a plain answer with its key figures as a chart or a table).

**Example**
```series
part d1 | Flat lease, 12 months
part c1 in=d1 | Clause 4: the deposit is kept if any damage is found
ask a1 in=c1 check=any pick=Fine,Question,Escalate | Your call on clause 4?
part c1a in=c1 tag=plain-words for=a1 | What it means
step in=c1a | Any damage, however small, lets the landlord keep the deposit.
part c1b in=c1 tag=ask-for for=a1 | What to ask for
step in=c1b | Ask for "beyond normal wear and tear" and an inspection list at move-in.
part c2 in=d1 | Clause 7: the rent rises each year
reply | Clause 4 questioned; clause 7 next.
```

**What failed** A summary of the whole document with no place for the person's own calls. A verdict on what is legal, given as if it were checked.

**Score** No run has scored this technique yet.
