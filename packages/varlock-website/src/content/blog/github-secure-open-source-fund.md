---
title: "How Varlock Is Leveling Up Security Through the GitHub Secure Open Source Fund"
description: "Varlock was selected for the GitHub Secure Open Source Fund. Here's what we learned about threat modeling, SBOMs, fuzzing, and the concrete security changes we shipped."
date: 2026-02-17
image: ../../assets/blog/github-sosf.jpeg
authors:
  - name: "Varlock Team"
---

We've got some exciting news to share: Varlock was one of the projects selected to participate in [Session 3 of the GitHub Secure Open Source Fund](https://github.blog/open-source/maintainers/securing-the-ai-software-supply-chain-security-results-across-67-open-source-projects/) back in September 2025. The fund pairs open source maintainers with security experts and resources to help projects strengthen their security posture. It was a genuinely valuable experience for us and we're lucky to have been included alongside some of the most important open source projects in the world.

## Why Security Matters Here

If you're using Varlock, you're trusting it with your environment variables - API keys, database credentials, tokens, etc. That's a uniquely sensitive attack surface, and one that's easy to overlook. A vulnerability in how we handle those secrets could expose the very things we've built to protect.

We've always taken that responsibility seriously. Varlock already ships with a whole suite of security features to help you keep secrets out of places they shouldn't be. But we knew there was more we could be doing on a fundamental level. Things like how we handle vulnerability reports, how we audit our own code, and how we think about threats in general.

That's exactly what this program helped us with: laying a strong security foundation for the future. 

## The Learning That Changed Our Thinking

The biggest shift for us was learning to think about security through **threat modeling**. Before the program, our security work was mostly reactive - fixing things as they came up, adding features when we saw a gap. Threat modeling gave us a structured way to ask: _what could go wrong, and where?_

It sounds simple, but it changes how we approach everything. Instead of waiting for a vulnerability to surface, we're mapping out our attack surface, thinking about trust boundaries, and prioritizing based on real risk. For a project that handles secrets, that mindset is not only just valuable, _it's essential_.

## What We Shipped

Here's what concretely changed as a result of the program:

- **[SECURITY.md](https://github.com/dmno-dev/varlock?tab=security-ov-file)** - We added a responsible disclosure policy with clear instructions for reporting vulnerabilities privately via [GitHub's security reporting](https://github.com/dmno-dev/varlock/security) or email (security@varlock.dev).
- **CodeQL scanning** - Automated code analysis running on every PR to catch potential vulnerabilities early.
- **Secret scanning** - GitHub now flags any accidentally committed secrets in the repo. Varlock is already a frontline defense here, but a little more can't hurt :) 
- **Dependabot alerts** - Automated notifications for known vulnerabilities in our dependencies.
- **Dependency graph** - Full visibility into our dependency tree and its security implications.
- **CI/Automation** - Improved security for our automation workflows. 

Beyond the tooling changes, we also learned about practices we're continuing to explore:

- **SBOMs (Software Bills of Materials)** - Understanding what goes into your software supply chain and how to document it. This is increasingly important as more organizations require SBOMs from their dependencies.
- **Fuzzing** - Throwing random, unexpected inputs at your code to find edge cases and crashes that normal testing misses. It's something we're looking into adopting for our core parsing and resolution logic.
- **AI Security** - LLMs and Agents introduce an entirely new set of attack surfaces that the industry is just beginning to come to terms with. We will continue to do more to improve both our, and our users's, security posture here. 

## What You Can Do Today

If you're using Varlock (or any tool that handles secrets), here are a few things worth doing:

- **Report vulnerabilities responsibly** - If you find a security issue in Varlock, please use our [private reporting](https://github.com/dmno-dev/varlock/security) or email security@varlock.dev.
- **Enable GitHub's security features** on your own repos - [Dependabot](https://docs.github.com/en/code-security/dependabot), [secret scanning](https://docs.github.com/en/code-security/secret-scanning), and [CodeQL](https://docs.github.com/en/code-security/code-scanning) are free for public repos and take minutes to set up.
- **Think about threat modeling** - Even a quick, informal exercise of "what could go wrong?" for your project can surface risks you hadn't considered. The [OWASP Threat Modeling guide](https://owasp.org/www-community/Threat_Modeling) is a solid starting point.
- **Monitor your dependencies closely** - It's the lowest-effort, highest-impact thing you can do for supply chain security.
- **Get your secrets out of plaintext** - Get those sensitive values out of plaintext and prevent them from being leaked. 

## Thank You

Thanks to [GitHub](https://github.com) and the Secure Open Source Fund sponsors (like our friends at [1Password](https://1password.com)) for making this program possible. It's made a real difference for us - not just in the tools we've enabled, but in how we think about security as a project.

We're still early in our journey, and there's plenty more to do. But we're building on a much stronger foundation now, and that benefits everyone who uses Varlock.

As always, come hang out with us on [Discord](https://chat.dmno.dev) or [GitHub Discussions](https://github.com/dmno-dev/varlock/discussions). We'd love to hear what security practices you've adopted in your own projects.
