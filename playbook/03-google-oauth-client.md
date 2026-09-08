# Play 03 — Google OAuth client

**Goal:** one Google Cloud OAuth 2.0 **Web application** client whose authorized redirect
URIs cover local, UAT and production, with the consent screen restricted to the client's
Workspace.

**Needs:** Play 02 closed (you need the final hostnames).

## Steps

### 1. Project and consent screen (Google Cloud Console)

1. Select or create a Google Cloud project owned by the client's Workspace organization.
2. **APIs & Services → OAuth consent screen.** User type **Internal** (Workspace only).
   App name = display name. Scopes: none beyond the defaults (`openid`, `email`,
   `profile`). Save.

If **Internal** is not offered, the project is not inside the Workspace organization.
Stop and move the project; **External** would still be gated by the `hd` check in the app,
but Internal is the second lock and the client expects it.

### 2. Create the client

**APIs & Services → Credentials → Create credentials → OAuth client ID.**
Application type **Web application**. Authorized redirect URIs, exactly:

```text
http://localhost:5173/api/auth/google/callback
https://uat.<domain>/api/auth/google/callback
https://<domain>/api/auth/google/callback
```

Download or copy the **client ID** and **client secret**. Put the secret nowhere yet
except a password manager. It goes into `.env.local` (Play 04) and the AWS secret
(Play 09).

### 3. Evidence

Paste the client ID (it is public by design) and the three redirect URIs as they appear
in the console, one per line.

**EVIDENCE 03.1**
**Accept when:** the client ID ends in `.apps.googleusercontent.com`; the three URIs match
the block above byte for byte (scheme, host, path, no trailing slash). Consent screen type
stated as `Internal`.

Never paste the client secret.

## Success criteria

- [ ] 03.1 accepted
- [ ] Client secret stored in a password manager, not in any file yet

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` at login (later plays) | The URI in the console differs from `GOOGLE_REDIRECT_URI` in the environment. Compare byte for byte. |
| Sign-in rejected after Google consent | Account's Workspace domain is not in `GOOGLE_ALLOWED_DOMAIN`, or it is a consumer Gmail (no `hd` claim). |
| `Internal` not available | Project is outside the Workspace organization. |
