# Security model

## Content encryption

Each space uses a cryptographically random 256-bit key generated in the browser. It is separate from account credentials and is never uploaded, put in invitation URLs, or persisted by this app. Users must keep it in a password manager and share it privately. Losing all copies permanently loses access to the content.

`site/crypto.js` uses the browser's native Web Crypto AES-GCM with a fresh random 96-bit nonce and a 128-bit authentication tag for every encryption. Version, workspace UUID, key epoch and record UUID (or the name marker) are authenticated as additional data. This prevents moving ciphertext between records/spaces/epochs without detection. JSON is padded to 512-byte blocks before encryption. Block counts remain visible. Imported keys are non-extractable CryptoKey objects held in memory; this is not protection against malicious same-origin JavaScript, which could use a key to decrypt.

All calendar/task content, including record kind and dates, is encrypted. Space names are encrypted too. Supabase stores ciphertext, public nonces, record/workspace/user identifiers, memberships/display names, creator IDs, timestamps and sizes. Supabase Auth handles login email addresses, password verification and MFA secrets. Account credentials are not end-to-end encrypted from the authentication provider. Passwords are sent to Supabase over HTTPS for verification; they are never stored in the app's calendar tables or repository.

## Access controls

All app tables have PostgreSQL row-level security. The anonymous role has no table privileges. Authenticated users must have `aal2` MFA assurance and belong to the space for data access. Column-level grants restrict editing to ciphertext, with constrained insert/delete access. Membership and owner actions use narrowly scoped security-definer functions with empty search paths and explicit checks. Invitation secrets are high entropy, expire after seven days and are stored only as SHA-256 hashes in a private, unexposed schema. Link fragments keep newly generated invitation tokens out of ordinary HTTP request URLs, but links are still bearer membership secrets.

An invitation grants membership after account/MFA verification; it does not carry the encryption key. Any verified holder of the invitation may join until it expires or is revoked, so send it only to intended recipients. Anyone with both membership and the content key can read and modify the space. Members cannot change ownership or rotate keys. The public publishable API key is deliberately public and conveys no administrative privilege.

Owners rotate all current ciphertext atomically using a fresh key and epoch. Rotation checks the complete record set and prior timestamps, rejecting concurrent edits rather than losing them. Removing a member performs the same rotation and revokes pending links. Remaining members need the new key. Authorized members can retain any plaintext, old key or ciphertext they already downloaded; removal cannot erase their copies. This is shared-key encryption, without per-device identity verification, forward secrecy or cryptographic attribution of individual writers.

## Browser and deployment boundaries

Login tokens and keys stay in memory with `persistSession: false`. Refreshing the page requires a new login. Lock clears key references, decrypted collections, forms and rendered content; idle locking runs every 15 seconds after a five-minute inactivity threshold, and rechecks on visibility change. JavaScript cannot promise physical memory erasure or deletion of clipboard history, browser/OS caches, screenshots, crash dumps or device backups. Clear the clipboard after saving a recovery key. A locked space retains its authenticated session until sign-out or expiry.

HTML text is escaped, scripts/libraries are local, and the CSP limits scripts/styles to this origin and network access to the configured Supabase endpoint. Referrers are suppressed and crawler directives request no indexing. Those directives are voluntary: they are not authorization controls. Public source and the login/demo page are visible to anyone. GitHub Pages does not provide per-repository custom security headers; the app has a frame guard, but cannot claim header-level frame protection or origin isolation from other pages hosted on the same `github.io` origin.

The browser receives executable code from GitHub Pages on every load. A compromised GitHub account, malicious deployment, dependency update, extension, browser, device or authorized recipient can expose plaintext/keys while the app is unlocked. Database encryption does not prevent those attacks. Protect GitHub and Supabase administrator accounts with MFA, review deployments/dependencies, and use trusted devices. Backend operators with only stored ciphertext cannot decrypt it without the key, but authentication and operational metadata remain accessible to the providers. No claim of absolute human/AI/crawler exclusion or independent security certification is made.

## Availability and recovery

Supabase Free limits, pauses or account/service loss can make the app unavailable. End-to-end encryption does not prevent record deletion, server rollback, traffic analysis or denial of service. Maintain encrypted database backups separately from recovery keys. A password reset restores account access only; it cannot recover the content key or a lost authenticator setup. Retain secure authenticator backups and arrange account recovery with the project owner if necessary.

## Validation and reporting

Automated Web Crypto/unit tests and PostgreSQL policy tests exercise the real application modules/schema. Browser checks use fictional data and a local mock backend. Live read-only checks verify anonymous table denial, private-schema exclusion, email confirmation and anonymous-login settings. A real two-person email/MFA/invitation flow and independent security audit are still needed before relying on this app for highly sensitive material.

Do not post passwords, recovery keys, invitation links or private calendar data in public GitHub issues. Report a suspected vulnerability privately to the repository owner, using a channel you already trust.
