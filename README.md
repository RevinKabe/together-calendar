# Together

A shared calendar with a to-do list underneath, email login, required authenticator verification, and browser-side encryption. Built with plain HTML, CSS, JavaScript and Supabase; served by GitHub Pages.

**App:** https://revinkabe.github.io/together-calendar/

## Deployment

The public frontend connects to a Supabase **Free** project in **Central EU (Frankfurt), `eu-central-1`**. Its encrypted database schema, membership policies and MFA enforcement are installed. The exact GitHub Pages URL is configured as the authentication site and allowed redirect. Email confirmation is required; anonymous sign-in is disabled. Passwords must have at least 14 characters, with email recovery links expiring after 15 minutes.

**Email setup remains required for collaborators:** Supabase's built-in sender only delivers to addresses belonging to the Supabase organization team. Configure custom SMTP before ordinary collaborators sign up or request a reset. Do not add collaborators as Supabase administrators to bypass this limit. See [Supabase email guidance](https://supabase.com/docs/guides/auth/auth-smtp). No real user's signup/email/MFA flow has been completed by automated tests.

## Start using it

1. Create an app account with a unique password of at least 14 characters and confirm the email. This is separate from your Supabase dashboard account.
2. Sign in, set up an authenticator app and verify its six-digit code. Save a private backup of the authenticator setup secret. Existing users verify their authenticator on sign-in.
3. Create a space. **Save its generated recovery key in your password manager before continuing.** The key never goes to Supabase. A password reset cannot recover a lost encryption key.
4. Add events and tasks. All content is encrypted before it leaves the browser.
5. Use **Invite people** to create a seven-day membership link. Send the link yourself. Share the recovery key separately through a trusted encrypted channel or password-manager sharing. An invite link alone cannot decrypt the plans.
6. Each member creates their own account, verifies MFA, accepts the invitation and enters the space key. Members can read, edit and delete the shared items.

This deployment is intended for two people. Once both accounts have been created, disable **Allow new users to sign up** in Supabase Authentication → Sign In / Providers. Existing users can continue signing in and resetting passwords.

Use **Lock** before leaving a device. The app also locks after five minutes without keyboard/pointer activity and on page exit. Login sessions and content keys are held in tab memory, so reloading requires sign-in and unlocking again. Browser/OS memory and clipboard copies cannot be reliably erased by JavaScript.

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

## Repository and setup

GitHub Actions checks JavaScript, runs unit tests and publishes **only `site/`** when `main` changes. Set Pages source to **GitHub Actions**. Paths support the repository subdirectory.

For a fresh Supabase project: enable Data API, disable automatically exposing new tables, and enable automatic RLS. Run [`supabase/schema.sql`](supabase/schema.sql) once. It is a fresh-project schema, not a migration for earlier plaintext versions. Keep the private schema outside the Data API. Enable email confirmation and TOTP, disable anonymous sign-in, set password length to 14, configure exact production URLs and custom SMTP. Put only the public project URL and publishable key in `site/config.js`; never commit admin/service-role keys, database passwords, personal tokens, recovery keys or SMTP credentials.

The vendored client is `@supabase/supabase-js` **2.118.0**, from its official UMD distribution; see [`site/vendor/LICENSE.supabase`](site/vendor/LICENSE.supabase).
