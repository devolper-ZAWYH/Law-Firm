# Security notes

Operational reference for the controls added during the August 2026 security
review, plus the risks that were assessed and knowingly accepted.

---

## Accepted risk: `xlsx@0.18.5`

**Status:** accepted, not remediated. Re-evaluate if the preconditions below change.

Two advisories apply to the version we run:

| Advisory | Issue | Fixed in |
| --- | --- | --- |
| CVE-2023-30533 | Prototype pollution while parsing a crafted workbook | 0.19.3 |
| CVE-2024-22363 | ReDoS in sheet parsing | 0.20.2 |

**Why it is not patched.** There is no fixed version on the npm registry.
SheetJS stopped publishing there after 0.18.5 and distributes patched builds only
from `cdn.sheetjs.com`. Upgrading therefore means pointing `package.json` at a
non-registry tarball, which makes every deploy depend on that CDN being reachable
at install time. `npm audit` reports these as unfixable for the same reason.

**Reachability.** Attacker-controlled bytes reach the parser here:

```
app/api/companies/[id]/attendance/parse/route.ts  (multipart upload)
  → lib/platform/attendance.ts  parseAttendanceWorkbook()
    → XLSX.read(buffer, …)
```

**Preconditions for exploitation.** The caller must be authenticated *and* hold
`membership_permissions.can_upload_attendance`, or be a manager/admin of the
company. This is not an unauthenticated surface.

**Compensating controls already in place.**

- `lib/platform/spreadsheetGuard.ts` rejects decompression bombs by reading the
  ZIP central directory before any inflation (64 MB declared-size ceiling, ZIP64
  refused, entry-count cap). This closes the memory-exhaustion path, which was
  the concretely reachable denial of service.
- The upload route caps the compressed body at 5 MB.
- The grant is narrow and individually assigned — it is not held by every
  employee by default.

**Residual exposure.** Prototype pollution from a crafted workbook, by a user who
already holds the attendance-upload grant, inside the shared Node process.

**Revisit when** any of the following becomes true: SheetJS resumes publishing to
npm; the attendance upload is opened to a wider set of users; or the app moves to
a deployment where the parse can be isolated (a separate worker or service).

---

## Operating the throttling controls

`lib/rateLimit.ts` reads these at process start. Defaults are correct for the
current single-instance Railway deployment; they exist so the values are not
buried in code.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXY_HOPS` | `1` | Proxy hops in front of the app that append to `X-Forwarded-For`. Railway's edge appends exactly one. |
| `LOGIN_MAX_CONCURRENT_VERIFICATIONS` | `2` | Concurrent bcrypt comparisons. |
| `LOGIN_MAX_QUEUED_VERIFICATIONS` | `20` | Callers that may wait for a slot before the route sheds with 503. |
| `ALLOWED_ORIGINS` | *(empty)* | Extra origins permitted to make state-changing API calls, comma-separated. |

**`TRUSTED_PROXY_HOPS` must match reality.** The client IP is read that many hops
from the *right* of `X-Forwarded-For`, because anything a client sends itself can
only appear to the left of what our own edge appended. Set it too high and the
count reaches back into caller-supplied values, and per-IP limiting stops working.
Add a proxy in front of Railway (e.g. Cloudflare) and this must become `2`.

**Load shedding is visible to users.** Past the concurrency limit, `/api/login`
returns `503` with `Retry-After` rather than queueing without bound. Under attack
that means slow logins instead of a stalled process; the defaults sustain roughly
four logins per second.

---

## Known limitations

Not defects — design boundaries worth stating before a security questionnaire
asks.

- **Throttle state is per-process and in-memory.** Rate-limit buckets and account
  lockouts reset on redeploy and are not shared between replicas. The global
  verification cap still bounds CPU correctly on each instance independently
  (it is a per-process resource), but the per-IP and per-account tiers become
  per-replica. Scaling horizontally requires backing them with a shared store.
- **Session revocation reads fail open.** `lib/tokenVersion.ts` returns `null` on
  any error and callers keep the session, so a database outage cannot lock every
  user out. Revocation *writes* now report failure honestly (`/api/logout`
  returns `revoked: false`), but the read side remains deliberately permissive.
- **A manager can edit their own working hours and ZKTeco id.** Working days feed
  that person's own attendance late/early totals, so this permits retroactively
  excluding a day. Self-granting *permissions* is blocked; this adjacent case was
  left in scope of normal manager authority.
- **No MFA, and a fixed 12-hour session with no idle timeout.**
- **No audit trail for security events.** `task_events` audits task workflow, but
  logins, failed logins, permission grants and password resets are not recorded.
  "Who granted this person delete rights, and when" is currently unanswerable.

---

## Running the tests

```bash
npm test
```

The suite is regression-focused: each test names the finding it pins. Every fix
was mutation-checked — the vulnerability was re-introduced and the corresponding
suite confirmed to fail — so these tests are known to detect what they claim to.
