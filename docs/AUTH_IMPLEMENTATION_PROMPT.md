# Reusable prompt — email OTP, password recovery, and Google sign-in

Paste the section below into a fresh session on another codebase. It is written as instructions,
not as a description, and it front-loads the decisions that are easy to get wrong — each one here
was a real defect first.

---

## The prompt

> Implement account recovery and third-party sign-in for this application. Follow the requirements
> below exactly; several of them exist because the obvious implementation is subtly wrong.
>
> ### 1. One-time codes by email
>
> - Send through the provider's **HTTP API, not SMTP**. Managed hosts (Render, Fly, Heroku) block
>   outbound SMTP ports, so an SMTP implementation works locally and fails silently in production.
>   Brevo's free tier (300 emails/day) needs only an API key and a verified sender address:
>   `POST https://api.brevo.com/v3/smtp/email`, header `api-key`, success is **201**.
> - Store codes hashed with a short TTL (10 minutes is right), single-use, and delete on use.
> - Rate-limit requests per destination.
> - **Never log a code**, and mask addresses in logs (`a***a@example.com`).
>
> **The trap:** a demo/offline mode that returns the code in the API response so the flow is usable
> without a provider. Write it so the code is returned **only** when demo mode is on — never as a
> fallback when delivery fails. The natural shape,
>
> ```
> if (!demoMode && delivery.send(...)) return null;
> return code;   // ← leaks the code to any caller whenever delivery fails
> ```
>
> hands a working credential to anyone who can trigger a send failure, including by requesting a
> code for an address the provider rejects. On a delivery failure: delete the stored code and
> return 503. Demo mode must be a separate branch, not a fall-through.
>
> ### 2. Sign-in with a code, then require a password
>
> - `POST /auth/otp/request` (public, takes an address) and `POST /auth/otp/verify` (returns a
>   session token).
> - Verification looks the account up by the **registered address**, never by an identifier the
>   caller supplies alongside the code.
> - After a code sign-in, present a **set-a-password step before continuing**. Without it, somebody
>   who has forgotten their password signs in by code forever and never recovers the account — the
>   one-time code becomes a permanent workaround rather than a recovery.
>
> To let that step work without an old password, put a claim on the token issued by code
> verification — call it `vbc` — meaning "this session began by proving control of the registered
> address". Then:
>
> - Honour it **only within a short window of issue** (15 minutes), checked against the token's
>   `iat`, so a session left open on a shared machine cannot rewrite the password hours later.
> - **Do not carry it across refresh.** A renewed session is no longer "just verified".
> - It must grant nothing else, ever.
>
> ### 3. Changing a password
>
> One endpoint, three accepted proofs, in this order: a valid `vbc` token within its window; a
> fresh one-time code; the current password. The first two are what make this a recovery rather
> than a convenience — somebody who has forgotten their password has no current password to give,
> and an account created through Google has never had one.
>
> - Return **one message for every proof failure**. Distinguishing "wrong current password" from
>   "wrong code" tells an attacker which half they got right.
> - Resolve the account from the **session**, never from a body parameter.
> - Return the **username the password was set on**, and show it. Recovery finds accounts by email
>   while sign-in finds them by username; when those differ — which they do for every account
>   created through Google — the user sets a correct password and is then told "invalid username or
>   password", with nothing on screen explaining why.
>
> ### 4. Sign in with a username **or** an email
>
> Try username first, then email if the input contains `@`. Two reasons this is not optional:
> recovery is keyed by email while sign-in is keyed by username, and accounts created through a
> social provider get a **generated** username the user has never seen. Normalise the email
> (trim, lowercase) and **skip accounts with no password hash** — passing null to a password
> encoder throws rather than returning false.
>
> If a username and someone else's email are the same string, the username wins; the field is
> labelled "username".
>
> ### 5. Google (OAuth2) sign-in
>
> - An **existing** account signs in with the role it already has. The provider proves who someone
>   is; it does not decide what they may do. Never change a role here.
> - An **unknown** identity is **refused** unless auto-provisioning is explicitly switched on
>   (default off), and even then it is created with a configured default role that is
>   **not privileged**.
> - Refuse when the provider withholds an email address — there is nothing to match on.
> - The callback must catch the refusal and **redirect to the frontend with an error message**.
>   Letting it propagate renders the backend's error page on the backend's domain, which looks like
>   a crash and strands the user off-site with no way back.
>
> **The trap:** find-or-create in the callback, defaulting new accounts to whatever role was
> convenient during development. Anyone who finds the login page then clicks "Continue with Google"
> and becomes a privileged user of someone else's system.
>
> ### 6. While you are here, audit these
>
> - **Public self-registration must not grant a privileged role.** Check the default.
> - A **self-asserted or anonymous token must not satisfy `authenticated()`**. If any endpoint
>   issues a token for an unverified identity (a guest or attendee pass), then `authenticated()`
>   means "asked for a token", not "is who they claim". Restrict anything reading real data to
>   roles that require a verified account.
> - **MFA challenge tokens and any scoped/short-lived tokens must never authenticate a session.**
>   Mark them with a type claim and reject that type in the authentication filter.
> - Sliding session expiry needs an **absolute cap**, carried in a claim set at first issue and
>   preserved across refreshes — otherwise a session renews itself forever.
>
> ### 7. Configuration
>
> Everything below is an environment variable with a safe default:
>
> | Variable | Default | Meaning |
> | --- | --- | --- |
> | `OTP_DEMO_MODE` | `true` locally, **`false` in production** | returns the code instead of sending it |
> | `OTP_EMAIL_PROVIDER` / `OTP_EMAIL_API_KEY` / `OTP_EMAIL_FROM` | — | provider, key, verified sender |
> | `OAUTH_AUTO_PROVISION` | `false` | may an unknown provider identity create an account |
> | `OAUTH_DEFAULT_ROLE` | least-privileged role | what such an account gets |
> | `APP_FRONTEND_URL` | — | where the OAuth callback redirects; **wrong value sends users to localhost** |
>
> ### 8. Tests I expect to see
>
> Write these as executable tests, and confirm each one **fails without the fix** — a test that
> passes either way is worse than none:
>
> 1. sign-in succeeds by username, and by email, including odd casing and stray whitespace;
> 2. sign-in refuses an account with no password hash instead of throwing;
> 3. a wrong password and an unknown identifier give the identical message;
> 4. a code is returned **only** in demo mode, and never on a delivery failure;
> 5. the `vbc` claim is absent from refreshed tokens, and expired outside its window;
> 6. an unknown provider identity is refused when auto-provisioning is off;
> 7. an existing account keeps its role after signing in through the provider;
> 8. any unverified/guest token is refused by every endpoint that reads real data.
>
> Do not report anything as working until you have run it. A successful compile is not a test, and
> an incremental build can succeed against code that no longer exists — use a clean build.

---

## Where each piece lives in this repository

Useful if you want to read a working version rather than start from the prompt.

| Concern | File |
| --- | --- |
| OTP issue, verify, demo-mode discipline | `backend/src/main/java/com/agmsentinel/service/OtpService.java` |
| Brevo HTTP delivery, address masking | `backend/src/main/java/com/agmsentinel/service/OtpDelivery.java` |
| Password change, the three proofs, sign-in by email | `backend/src/main/java/com/agmsentinel/service/AuthService.java` |
| `vbc` claim, session start, absolute cap | `backend/src/main/java/com/agmsentinel/security/JwtService.java` |
| OAuth callback and its refusal redirect | `backend/src/main/java/com/agmsentinel/security/OAuth2SuccessHandler.java` |
| Route rules, and why a guest token is not "authenticated" | `backend/src/main/java/com/agmsentinel/config/SecurityConfig.java` |
| Forgot-password and set-password steps | `frontend/src/app/pages/login.component.ts` |
| Change-password panel, both proof paths | `frontend/src/app/pages/security.component.ts` |
| Tests | `backend/src/test/java/com/agmsentinel/service/AuthServiceLoginTest.java`, `.../security/AttendeeAccessTest.java` |
