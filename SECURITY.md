# Security policy

## Supported version

Security fixes are made on the current `main` branch and deployed Cloudflare
version. Historical Go binaries and older Worker versions are not maintained as
separate supported releases.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** form in the repository Security tab.
Private vulnerability reporting is enabled. Please do not open a public issue
for a suspected vulnerability and do not include real user data, credentials,
browser tokens, room codes, recordings, or transcripts in a report.

Include, when available:

- the affected route, component, and commit or deployment time;
- a minimal reproduction using synthetic data;
- the security impact and required preconditions;
- whether the issue concerns the Cloudflare or local Go edition;
- suggested mitigations, without testing against other users or active rooms.

## Safe testing boundaries

The public site is a live service. Do not perform denial-of-service testing,
distributed rate-limit testing, credential guessing, social engineering, data
exfiltration, or destructive database/storage actions. Use a local Wrangler
environment or the designated staging Worker for reproducible testing.

## Operational response

Maintainers should acknowledge a credible private report, preserve evidence,
rotate affected secrets, disable optional model providers when relevant, fix
forward through a reviewed pull request, and follow
[`docs/PRODUCTION_OPERATIONS.md`](docs/PRODUCTION_OPERATIONS.md). Public
disclosure should wait until a fix is deployed and affected credentials or data
have been addressed.
