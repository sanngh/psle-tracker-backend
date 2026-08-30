# Post-Pilot TODO

Tracked items deferred until after the closed pilot (Android Closed Testing / iOS TestFlight), plus a few pre-pilot items that must be finished before launch.

## Must do before pilot launch

- [ ] **Restart the live backend** so recent fixes actually take effect:
  - BigInt serialization fix in the Turso adapter (`run()` returning raw `BigInt` for `lastInsertRowid`, crashing `res.json()` on consent/uploads/etc.).
  - `get()` truthiness fix in the Turso adapter (`{}` was returned instead of `undefined` for "no row found", causing every Turso-backed account to resolve as `parent` regardless of actual role/links).
  - After restart, re-verify role resolution and consent save behave correctly for a live account.
- [ ] **Point `frontend/.env.production` at the deployed HTTPS API** — required for Android Closed Testing and iOS TestFlight builds (LAN URLs only work for local testing).
- [ ] **Create `app.json` / `eas.json`** for EAS builds (Android Closed Testing + iOS TestFlight).
- [ ] iOS TestFlight requires an active Apple Developer Program membership (external/account setup, not code).
- [ ] **Audit other Turso live-data assumptions** for the same falsy/truthy class of bug (any `if (row)` / `if (link)` check against a `db.get()` result) — the adapter fix should cover it going forward, but worth one pass of live verification against Turso, not just local SQLite tests.

## Post-pilot enhancements

- [ ] **Push notifications (`expo-notifications`)** for parent alerts (syllabus milestone, revision progress, exam completed) so parents are notified even when the app is closed. Requires push token registration, Apple Push cert/key + Firebase/FCM setup, and wiring sends into the existing alert-computation logic in `/api/dashboard`.
- [ ] **Distinct consent wording for students vs parents.** Currently both roles see the same `disclaimer.json`, whose checkbox text claims "I confirm that I am the parent/legal guardian..." — not accurate for a student account. Since students are now locked out until their linked parent consents on their behalf, consider either:
  - Showing students a simpler acknowledgement notice (not a PDPA legal consent claim), or
  - Skipping the PDPA modal entirely for student accounts since the parent's consent already covers them.
- [ ] **Backend logging** — was discussed and attempted once, but never actually landed in `server.js`. Add structured request/error logging (e.g. for diagnosing live issues without manual DB probing).
- [ ] **Move offline evidence queue off AsyncStorage** onto a more durable/generic sync queue (e.g. Expo SQLite), matching the durability of the rest of the app's local storage.
- [ ] **Add automated tests that run against the Turso adapter**, not only local SQLite. The Turso-only bugs above (BigInt serialization, falsy/truthy row handling) were invisible to `npm test` because the suite always forces `USE_SQLITE=true`. A parallel Turso-mode test run (or an adapter-level unit test) would catch this class of bug automatically.
- [ ] **Owner GUI** — remains a separate, unaddressed surface; review/test it once the main pilot is stable.

## Notes

- Do not print Turso/R2 credential values in tool output or chat again once rotated.
- `backend/.env` is git-ignored; production template (`backend/.env.prod`) defaults safely to SQLite/local until explicitly switched to Turso/R2.
