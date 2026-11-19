# Security policy

This is a reference / portfolio project, not a hosted service — there is no
production deployment to attack. But it verifies webhook signatures and makes
exactly-once claims, so if you find a way those fail, I want to know.

## Reporting

If you find a real issue in the code — a signature-verification bypass (a forged or
tampered request accepted, a replay past the timestamp window, a timing leak in the
compare), a way two deliveries of one event both do the work, or a hole in the
retry / dead-letter path — please report it privately:

- Open a **GitHub Security Advisory** on this repository (Security → Report a
  vulnerability), or
- email **security@shadowvivo.com**.

Please don't open a public issue for a security problem until it's fixed. No bounty
is offered, but I'll credit you unless you'd rather stay anonymous.

## Scope

In scope: signature verification (`src/signature.ts`), the idempotent claim, and
the retry / dead-letter correctness described in [`DESIGN.md`](DESIGN.md).

Out of scope (documented limitations, not bugs — see DESIGN.md "What this does NOT
handle"): durability of the in-memory store, the mid-processing-crash orphan (needs
a lease/sweep), and the non-idempotent chat step. The CRM and chat clients are
in-memory fakes; there are no real credentials or endpoints.
