# Gloss

`PLAN.md` is the spec: read it in full before writing code, work one phase at a
time, and stop at the end of each phase for the owner to confirm.
`DECISIONS.md` records choices and — importantly — which third-party API
details are still unverified. Keep both and `README.md` current.

- Do not trust memory for Soniox, Electron or the Anthropic SDK; read the docs
  and note in `DECISIONS.md` what was read and what could not be.
- Checks: `npm run typecheck`, `npm test`.
- No audio, transcripts of real calls, or API keys in git.
