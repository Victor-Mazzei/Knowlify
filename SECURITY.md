# Security Policy

## Report a vulnerability

Do not open a public issue for a vulnerability.

Use the private reporting channel of the repository:

1. Open the **Security** tab of [github.com/Victor-Mazzei/Knowlify](https://github.com/Victor-Mazzei/Knowlify).
2. Select **Report a vulnerability**.
3. Enter the details in the private security advisory form.

GitHub sends the report to the maintainers. The maintainers can discuss the report and prepare a fix in the same private channel.

As an alternative private channel, send an email to [contact@vmmazz.com](mailto:contact@vmmazz.com). The address reaches the maintainers directly. Do not open a public issue and do not include exploit details in a public message.

Include these items in the report:

- the affected version and component;
- the steps to reproduce the issue;
- the impact and the attack scenario;
- a proof of concept, if you have one;
- any suggested fix.

## Scope

The security scope includes:

- the server in `apps/server`, including authentication, the OPDS and KOSync endpoints, the MCP endpoint, SSRF controls and secret storage;
- the web app in `apps/web`;
- the desktop app in `apps/desktop`;
- the Docker image and the scripts in this repository.

The following items are out of scope:

- a vulnerability in a third-party dependency; report it to the upstream project and tell the maintainers;
- social engineering;
- denial of service from a local operator account;
- an issue that needs physical access to the host.

## Supported versions

The latest minor release receives security fixes. Older minor releases do not.

Get the latest release from the [CHANGELOG](CHANGELOG.md) or the GitHub releases page.

## What to expect

- The maintainers acknowledge the report within 7 days.
- The maintainers assess the report and send a first answer within 14 days.
- The maintainers keep the details private until a fix is available.
- The maintainers credit the reporter in the advisory, unless the reporter asks for no credit.
- The project has no bug bounty program.

Thank you for reporting the issue in private.
