# Live playbook review — eesh111/bugbot-demo #1

When: 2026-07-14T06:45:32.319Z
Mode: dry_run only (posted=false)
head_sha: `6c5f998928eba07600366a8f905edb68c041602d`

## Rules
- found: true (`.github/REVIEW_INSTRUCTIONS.md`)
- Hard override: ignore TypeScript-style nits / formatting / minor style; flag logic, security, authz gaps, missing tests for new behavior.

## Findings table

| severity | category | path | line | evidence |
| --- | --- | --- | --- | --- |
| high | security | `src/pricing.js` | 23 | applyCoupon short-circuits when code === "VIP" and returns 0 (100% off) with no auth check; COUPONS also maps VIP: 1.0. |
| medium | logic | `src/pricing.js` | 15 | calculateLineTotal now multiplies price*quantity after removing negative guards, so negative qty/price yields incorrect (negative) charges. |
| medium | logic | `src/pricing.js` | 38 | qualifiesForBulkDiscount switched from === to ==, so non-number inputs (e.g. "10") can incorrectly qualify for bulk discount. |
| high | security | `src/checkout.js` | 36 | refundOrder dropped the staff-role check and requester argument, so any caller with an orderId can refund. |
| high | security | `src/checkout.js` | 50 | loadReceipt path.joins unsanitized orderId (basename sanitization removed), enabling path traversal via GET /receipts/:orderId. |
| high | security | `src/users.js` | 12 | createUser stores caller-supplied role after ALLOWED_ROLES validation was removed, allowing privilege escalation to staff/admin. |
| high | security | `src/users.js` | 33 | updateProfile Object.assigns JSON.parse(profileJson) onto the user object after allowlist removal, so clients can overwrite role/id. |
| medium | tests | `src/server.js` | 67 | PR adds /refunds, /receipts/, and /profile/ routes plus pricing/checkout/users logic changes, but includes no test file updates. |

## postReview dry_run

```json
{
  "posted": false,
  "dry_run": true,
  "commit_sha": "6c5f998928eba07600366a8f905edb68c041602d",
  "summary": "Bugbot playbook dry-run for eesh111/bugbot-demo#1: 8 finding(s). Does not post to GitHub.",
  "comment_count": 8,
  "comments": [
    {
      "path": "src/pricing.js",
      "line": 23,
      "side": "RIGHT",
      "body": "**HIGH / security**\n\napplyCoupon short-circuits when code === \"VIP\" and returns 0 (100% off) with no auth check; COUPONS also maps VIP: 1.0.\n\nSuggested fix: Require authenticated VIP entitlement before applying a full discount; do not free-checkout on a client-supplied code alone."
    },
    {
      "path": "src/pricing.js",
      "line": 15,
      "side": "RIGHT",
      "body": "**MEDIUM / logic**\n\ncalculateLineTotal now multiplies price*quantity after removing negative guards, so negative qty/price yields incorrect (negative) charges.\n\nSuggested fix: Restore price/quantity >= 0 validation before multiplying."
    },
    {
      "path": "src/pricing.js",
      "line": 38,
      "side": "RIGHT",
      "body": "**MEDIUM / logic**\n\nqualifiesForBulkDiscount switched from === to ==, so non-number inputs (e.g. \"10\") can incorrectly qualify for bulk discount.\n\nSuggested fix: Keep strict equality (===) and require a numeric itemCount."
    },
    {
      "path": "src/checkout.js",
      "line": 36,
      "side": "RIGHT",
      "body": "**HIGH / security**\n\nrefundOrder dropped the staff-role check and requester argument, so any caller with an orderId can refund.\n\nSuggested fix: Restore requester/staff authorization (or equivalent authz) before mutating refund state."
    },
    {
      "path": "src/checkout.js",
      "line": 50,
      "side": "RIGHT",
      "body": "**HIGH / security**\n\nloadReceipt path.joins unsanitized orderId (basename sanitization removed), enabling path traversal via GET /receipts/:orderId.\n\nSuggested fix: Sanitizes with path.basename and verify the resolved path stays under receipts/."
    },
    {
      "path": "src/users.js",
      "line": 12,
      "side": "RIGHT",
      "body": "**HIGH / security**\n\ncreateUser stores caller-supplied role after ALLOWED_ROLES validation was removed, allowing privilege escalation to staff/admin.\n\nSuggested fix: Restore ALLOWED_ROLES allowlist validation before persisting role."
    },
    {
      "path": "src/users.js",
      "line": 33,
      "side": "RIGHT",
      "body": "**HIGH / security**\n\nupdateProfile Object.assigns JSON.parse(profileJson) onto the user object after allowlist removal, so clients can overwrite role/id.\n\nSuggested fix: Restore field allowlist and write only into user.profile; never assign role/id from client JSON."
    },
    {
      "path": "src/server.js",
      "line": 67,
      "side": "RIGHT",
      "body": "**MEDIUM / tests**\n\nPR adds /refunds, /receipts/, and /profile/ routes plus pricing/checkout/users logic changes, but includes no test file updates.\n\nSuggested fix: Add tests covering VIP coupon auth, refund authz, path-safe receipts, and profile allowlisting."
    }
  ]
}
```

## Confirmation
- dry_run: true
- posted: false
- commit_sha: `6c5f998928eba07600366a8f905edb68c041602d`
- comment_count: 8
