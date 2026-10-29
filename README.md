# Together

A shared calendar with a to-do list underneath, email login, required authenticator verification, and browser-side encryption. Built with plain HTML, CSS, JavaScript and Supabase; served by GitHub Pages.

**App:** https://revinkabe.github.io/together-calendar/

## Deployment

The public frontend connects to a Supabase **Free** project in **Central EU (Frankfurt), `eu-central-1`**. Its encrypted database schema, membership policies and MFA enforcement are installed. The exact GitHub Pages URL is configured as the authentication site and allowed redirect. Email confirmation is required; anonymous sign-in is disabled. Passwords must have at least 14 characters, with email recovery links expiring after 15 minutes.

**Current access:** two people use one existing shared app account. Public signups are disabled in Supabase and the app. The account owner completed signup and reports successful setup; real passwords, authenticator secrets and recovery keys were entered privately, outside automated tests.

The built-in email sender remains sufficient for this account, whose email belongs to the Supabase organization team, subject to its low sending limit. Custom SMTP is deferred. It is needed if separate accounts at other email addresses are added later. Do not add calendar collaborators as Supabase administrators to bypass this restriction. See [Supabase email guidance](https://supabase.com/docs/guides/auth/auth-smtp).

## Start using it

1. On each device, sign in with the existing shared app email and password. This is separate from the Supabase dashboard account.
2. Enter a valid six-digit code from the authenticator enrolled for this account. Both people need access to valid codes; keep the authenticator setup backup private.
3. Unlock the existing space using its recovery key. Optionally check **Remember the key on this device** on a trusted browser. After that, sign-in and authenticator verification unlock the space without entering the key again. **Keep that key in your password manager.** The key never goes to Supabase. A password reset cannot recover a lost encryption key.
4. Add events and tasks. All content is encrypted before it leaves the browser. The shared account sees the same spaces on both devices; an invitation is unnecessary.

Share the app credentials and recovery key privately through a trusted encrypted channel or password-manager sharing. Both people act as the same owner with the same permissions. There is no per-person audit trail or way to revoke only one person's account access. Do not share Supabase or GitHub administrator credentials.

If switching to separate accounts later, first configure email delivery, then deliberately enable backend signups and set `allowSignups: true` in `site/config.js`. Invite the second account through **Invite people**, sharing the recovery key separately. Close backend signups and set the frontend flag back to false after registration. The frontend flag controls only the UI; Supabase enforces the actual signup policy.

Use **Lock** before leaving a device. The app also locks after five minutes without keyboard/pointer activity and on page exit. Login sessions remain in tab memory, so reloading requires sign-in and authenticator verification again. With a remembered key, unlocking after Lock requires a fresh authenticator code; without one, it requires the recovery key.

If your space is already unlocked, choose **Device key → Remember the key on this device**. The setting starts off and applies separately to each browser/profile and space. It stores a non-extractable Web Crypto key in IndexedDB, scoped to this app, account and encryption-key version. It does not save the recovery-key text or calendar content. Use **Device key → Forget this key and lock** to remove a saved copy. The sign-in page also has **Forget saved keys on this device** to remove all saved keys for this app. Signing out retains remembered keys; other tabs are notified when a saved key is forgotten.

A key change removes the old saved copy and offers to remember the replacement. Other browsers need the new recovery key once. Cleared/evicted site data, private browsing or disabled storage may require entering it again. If saving fails, the app explicitly says the key was not remembered. Browser/OS memory, clipboard copies and backups cannot be reliably erased by JavaScript. Remembering a key increases trust in the device/browser; MFA is not a hardware or encryption barrier around the local key.

Owners can revoke pending invitations, change the encryption key, or remove a member. Removal atomically changes the key and re-encrypts current records; save and privately redistribute the replacement key to remaining members. Old invitations are revoked. Previously downloaded copies cannot be recalled.

## Privacy and security

See [SECURITY.md](SECURITY.md) for the threat model and limitations. Space names, event/task titles, notes, dates, times, categories, assignments and completion state are encrypted with AES-256-GCM. Row-level security separately requires verified MFA and membership. Recovery keys are independent random 256-bit secrets.

Supabase still handles account email addresses, password verification, authenticator secrets, membership metadata and operational logs. GitHub serves public source code. Frankfurt is the primary project region, not a promise that every operational/support process stays in Germany; see [Supabase's data location explanation](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq).

The app has no analytics, remote fonts, third-party scripts or external QR service. Its Supabase library is vendored. A restrictive CSP allows network connections only to this Supabase project; crawler directives request no indexing, while authentication and encryption provide the actual data protections. There is no guarantee against compromised devices, malicious authorized members or a compromised frontend deployment. This implementation has not received an independent security audit.

## Features

- Responsive Monday-first calendar, previous/next month and Today controls.
- Events with optional time, category and notes; shared tasks below with due dates, assignments and completion filters.
- Multiple encrypted spaces, owner-controlled membership and expiring invite links stored as hashes.
- Optimistic concurrency checks reject stale edits instead of silently overwriting them.
- Changes refresh every 15 seconds while the page is visible. Membership revocation and key changes lock the affected space on the next successful refresh.
- Clearly labeled fictional demo, held in memory only and reset on reload. It makes no backend requests. Earlier versions used `together-demo-v1` in browser local storage; the current app does not read it. Clear old site storage yourself if you previously entered sensitive demo text.

Dates/times are floating calendar values: `18:30` means 18:30 to every member, without timezone conversion. Task assignments are labels, not notifications. Keep the recovery key and database backup separately: neither alone restores the encrypted calendar. The Free plan has service and quota limits; configure a backup process before relying on it for irreplaceable records.

## Local development and tests

Requires Node.js 24+. The frontend has no package-install or build step.

```sh
node scripts/serve.mjs
node --check site/app.js
node --check site/crypto.js
node --check site/encrypted-store.js
node --test tests/*.test.mjs
```

Open http://127.0.0.1:4173 and choose **Explore the demo**. The production backend only allows the deployed redirect URL. For a separate development project, update `site/config.js` and the exact allowed Supabase origin in the CSP in `site/index.html`.

PostgreSQL integration tests execute the actual schema with PGlite 0.5.13. The bootstrap downloads its official npm package to ignored `.tools/`:

```powershell
./scripts/test-database.ps1
```

Tests cover MFA enforcement, anonymous denial, member isolation, encrypted round trips, tampering and wrong-key failures, creator spoofing, immutable ownership, stale writes, atomic rotation/rollback, member removal and invalid/expired/revoked invites. The local browser fixture uses fictional accounts and code `123456`, makes no external requests, and rejects plaintext content/keys in mocked backend writes:

```sh
node scripts/serve-fixture.mjs
```

Open http://127.0.0.1:4180. The fixture is outside `site/` and is never deployed. Read-only live anonymous-policy checks are available with `node scripts/check-hosted-access.mjs` using only the public client key.

Open http://127.0.0.1:4180/__device-tests.html for 22 checks against native IndexedDB and Web Crypto: persistence/non-extractability, account/app/space separation, stale-version cleanup, forget ordering, malformed keys and unavailable storage. The app fixture retains fictional ciphertext in local storage to simulate a backend across reloads and tabs; it resets authenticator assurance on every reload and never calls Supabase.

## Repository and setup

GitHub Actions checks JavaScript, runs unit tests and publishes **only `site/`** when `main` changes. Set Pages source to **GitHub Actions**. Paths support the repository subdirectory.

For a fresh Supabase project: enable Data API, disable automatically exposing new tables, and enable automatic RLS. Run [`supabase/schema.sql`](supabase/schema.sql) once. It is a fresh-project schema, not a migration for earlier plaintext versions. Keep the private schema outside the Data API. Enable email confirmation and TOTP, disable anonymous sign-in, set password length to 14, configure exact production URLs and custom SMTP. Put only the public project URL and publishable key in `site/config.js`; never commit admin/service-role keys, database passwords, personal tokens, recovery keys or SMTP credentials.

For initial account creation in a new deployment, temporarily set `allowSignups: true` with backend registration enabled. Disable both after the intended account(s) exist.

The vendored client is `@supabase/supabase-js` **2.118.0**, from its official UMD distribution; see [`site/vendor/LICENSE.supabase`](site/vendor/LICENSE.supabase).
