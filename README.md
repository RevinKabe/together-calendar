# Together

A shared calendar with a to-do list underneath, email login, and invitation-based spaces. Built with plain HTML, CSS, JavaScript, and Supabase. The frontend is hosted on GitHub Pages.

**Site:** https://revinkabe.github.io/together-calendar/

## Current deployment

The frontend and interactive local demo are ready. **Shared login and cross-device storage require a Supabase project; none is configured yet.** The page says so explicitly. Demo data lives only in the current browser, under `together-demo-v1`, and is never presented as shared data.

## Connect a backend

1. Create a Supabase project in your own account. For a German primary hosting location, choose **Central EU (Frankfurt), `eu-central-1`**, explicitly.
2. Run [`supabase/schema.sql`](supabase/schema.sql) once in the fresh project's SQL editor. It creates tables, membership policies, and invitation functions in one transaction.
3. In Supabase Authentication, enable email/password login and email confirmation. Set the Site URL to `https://revinkabe.github.io/together-calendar/`. Add that exact URL to the allowed redirect URLs. Add `http://127.0.0.1:4173/` only if you need local authentication testing.
4. Configure production SMTP in Supabase for confirmation and reset emails to your collaborators. Supabase's default email sender is restricted and is not intended for general production delivery. See [Supabase email guidance](https://supabase.com/docs/guides/auth/auth-smtp).
5. Add the project's public URL and **publishable** key to [`site/config.js`](site/config.js). A legacy `anon` key also works. **Never add a service-role key, secret key, database password, or personal access token.** The publishable key is public by design; database policies enforce access.
6. Commit and push to `main`. GitHub Actions publishes `site/` automatically.
7. Create your account, confirm your email, sign in, and create a space. Use **Invite people** to generate a link and send it to your collaborators yourself. They create their own accounts and explicitly accept the invitation.

### Privacy and hosting

GitHub Pages serves public frontend code. Private calendar and task records are stored only in Supabase and protected by PostgreSQL row-level security. Selecting Frankfurt places primary project services there; it is not a guarantee that all operational or support processing remains in Germany. See [Supabase's data location explanation](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq).

## Features

- Responsive, Monday-first month calendar, previous/next month and Today controls.
- Add, edit, and delete dated events with an optional local time, category, and notes.
- Shared tasks underneath, quick add, optional due dates, display-name assignments, completion and filtering.
- Email/password signup, sign-in, sign-out, and password recovery.
- Multiple shared spaces. Only invited members can view or edit a space.
- Owner-generated, high-entropy invite links, valid for 7 days; only their SHA-256 hashes are stored.
- Owners can revoke invite links and remove members. Removing a member also revokes existing links.
- Changes refresh across signed-in browsers every 15 seconds while the page is visible. Revoked membership clears displayed records on the next refresh.
- An explicitly labeled local demo with sample plans. No backend connection is used by the demo.

Event dates and times are floating calendar values: `18:30` means 18:30 to everyone in the space, with no automatic timezone conversion. Task assignments are labels, not notifications. Concurrent changes use last-write-wins. No analytics, external fonts, or third-party assets are requested by the frontend. Authentication stores the browser session using Supabase's standard client behavior.

## Local development

Requires Node.js 24 or newer. There is no package installation or build step for the frontend.

```sh
node scripts/serve.mjs
```

Open http://127.0.0.1:4173 and select **Explore the demo**.

```sh
node --check site/app.js
node --test tests/calendar.test.mjs
```

PostgreSQL integration tests execute the real schema and policies using PGlite 0.5.13. The bootstrap script downloads the official npm package to an ignored local `.tools/` directory:

```powershell
./scripts/test-database.ps1
```

These tests cover unauthenticated access, isolation between spaces, shared editing, membership bypass attempts, creator spoofing, immutable record ownership, invalid/expired/revoked invites, and member removal. Live email delivery and hosted authentication still require verification after backend provisioning.

## Deployment

The workflow in `.github/workflows/pages.yml` checks the JavaScript, runs calendar tests, and uploads only `site/` to GitHub Pages. Set the repository's Pages source to **GitHub Actions**. All asset paths are relative, so project-site subpaths work.

The vendored browser client is `@supabase/supabase-js` **2.118.0**, from the official package's UMD distribution. See [`site/vendor/LICENSE.supabase`](site/vendor/LICENSE.supabase).
