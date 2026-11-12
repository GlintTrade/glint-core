# Security policy

Glint agents trade real funds. We take reports seriously and respond quickly.

## Reporting a vulnerability

Send a direct message on X to **[@Glint_Trade](https://x.com/Glint_Trade)** starting with `SECURITY`. There is no
support email. Please include, or offer to share privately:

- what is affected (package, file, contract function or live endpoint);
- steps to reproduce or a proof of concept;
- the impact you expect (loss of funds, bypass of a risk limit, key exposure, denial of service, and so on).

Please do **not** open a public issue, pull request or discussion for a vulnerability, do not post details publicly
on X, and do not test against accounts or agents that are not yours.

## What to expect

- Acknowledgement within 72 hours.
- An initial assessment and severity within 7 days.
- Coordinated disclosure: we fix first, then credit you publicly if you wish.

## Scope

In scope:

- the code in this repository, in particular the risk engine (`packages/risk`), the decision loop and key handling
  (`packages/runner`), order signing and the signer capability split (`packages/lighter`) and receipt encoding
  (`packages/agenthub`);
- the AgentHub contract on Robinhood Chain at `0xCAC8C7daE63C153495A6DA94F74c1Ee915DCBa0c`;
- the hosted service at tradeglint.xyz.

Especially valuable: any way to make an agent trade outside its risk limits, trade on an account that did not register
its key, make agent code sign anything other than create order, cancel and cancel all, exfiltrate or misuse an agent
API key, forge or suppress receipts, or buy a listing whose strategy differs from the one reviewed.

Out of scope: findings that require a compromised user wallet or machine, social engineering, volumetric denial of
service, and issues in third-party services (Lighter, Robinhood Chain, model providers) unless Glint's use of them is
the cause.

## Safe harbor

We will not pursue legal action for good-faith research that follows this policy, avoids privacy violations and
service disruption, and gives us reasonable time to fix the issue before disclosure.
