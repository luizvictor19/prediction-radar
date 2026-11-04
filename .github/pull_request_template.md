Closes #

<!--
The closing keyword reads no negation: "does not close" followed by a hash and
a number closes that issue anyway. To mention an issue without closing it,
write the number without the hash.
-->

## What changed

## What differs from the plan

<!-- "Nothing" when nothing changed. A change that touches production, the database or the architecture goes back for approval first. -->

## How to test

<!-- Up to 3 steps. Claude Code has no browser: screen testing is Luiz's. -->

1.

## Gate

- [ ] `npm run check`
- [ ] `npm run test:db` (when the change touches a query or a migration; CI runs it on every PR)
- [ ] `npm run typecheck --prefix web` (when the change touches `web/`; CI runs it on every PR)
