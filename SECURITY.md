# Security policy

Thank you for helping keep Thunderbird Pro services safe. Please report vulnerabilities privately
and give us time to fix them before sharing details.

## How to report

**Preferred:** use GitHub's private vulnerability reporting on this repository — **Security →
Report a vulnerability**. It opens a private advisory that only you and our security responders can
see, and you can follow the fix there.

**Alternative:** email `services-security@thunderbird.net`. We will open a private advisory on your
behalf and send you its ID.

Please do not open a public issue or pull request for a security problem, and do not post details
in chat rooms.

## What to include

- The product and the part affected (for example "Send web app, share links").
- What an attacker could do, and what they would need (an account? the victim's link?).
- Steps to reproduce, or a proof of concept. Attach files rather than pasting them into the title.
- The version or environment you tested against.
- Whether you have shared this with anyone else, and whether you have a disclosure deadline.

## What to expect from us

- An acknowledgement from a named engineer within **2 working days** (Monday–Friday, Toronto
  time), including the advisory ID and when you will hear next.
- Our assessment within **3 working days** after that: whether we can confirm it, how severe we
  consider it for our deployment, and our target date for the fix. If we disagree with you, we
  will say why and listen if you have more.
- An update at least every two weeks while the report is open.
- Fixes are deployed on a timeline set by severity, and the advisory is published once the fix is
  live. When several related reports arrive together we may publish them on one date.
- Credit in the published advisory under the name or handle you choose, unless you prefer none.

We publish GitHub security advisories and do not request CVE identifiers ourselves. If you would
like a CVE, you are free to request one and we will link it from the advisory.

We do not run a bug bounty programme and do not pay for reports.

## Scope

In scope: the production services and clients in this repository as we operate them — the web
applications, the backend APIs, and the Thunderbird add-on distributed through
addons.thunderbird.net.

Out of scope: our staging or development environments, self-hosted copies of this code run by
others, third-party services we depend on (report those to their maintainers), and social
engineering of our staff or users.

## Safe harbour

If you follow this policy, act in good faith, avoid privacy violations and service disruption, and
do not access or modify data that is not yours, we will not pursue legal action against you for
your research. Please stop and tell us immediately if you encounter user data you did not expect.
