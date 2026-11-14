# A piece that lasts a stated number of seconds

summary: A length was asked for in seconds: a three-second sting, a ten second clip, fifteen seconds long, lasting five seconds.
reason: only if the user gave a length in seconds

Makes a piece play for the length that was asked, first line to last.

**Use it when** the request names a number of seconds. Add the time up as you write: at brisk pace a short line of words takes about a second and a half, a drawn shape half a second; hold the last picture with an exact wait.

**Not when** no length was given: let the painter pace it.

**Example**
```series
look riso
scene solo brisk align=center
circle sun 80,45 4 fill=accent enter=pop
circle sun 80,45 26 fill=accent
say shout | DAYBREAK
wait 0.6s
```

**What failed** A three-second sting written at steady pace with four lines of words: it played for eleven seconds. Reading time is added to every line of text, so words are the costly thing.

**Score** No run has scored this technique yet.
