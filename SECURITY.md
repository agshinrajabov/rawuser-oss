# Security

## Reporting a vulnerability

Write to **security@userawuser.com**. Please do not open a public issue or
pull request for a vulnerability.

Tell us what you found, how to reproduce it and what an attacker could do
with it. A person reads every report and answers it. We tell you when the
fix is out, and we name you in the release notes if you want that.

## What is in scope

- The code in this repository: the snippet, the edge worker, the
  generation worker and the dashboard.
- The hosted Rawuser service, which runs this code.

Three kinds of finding matter most to us, because the product's promise
rests on them: anything that lets one customer read another's data,
anything that lets a visitor be identified or followed, and anything that
lets a page be changed by someone who is not its owner.

## What is not

- A weakness in your own install's settings (a token you published, a
  dashboard you left open). Tell us if a default made it easy.
- Volume attacks, and anything that needs access to someone else's account
  or device.

## While you test

Use your own install, or your own account on the hosted service. Do not
read, change or delete data that is not yours, and stop as soon as you can
show the problem.

## Supported versions

The latest release. A fix goes into the next one.
