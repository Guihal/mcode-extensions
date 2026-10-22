---
description: Confirm the requested outcome through observed behavior and relevant logs
alwaysApply: true
---

# Runtime behavior and logs

This Markdown guidance mirrors `73-tests-not-proof`; the injection-rules engine loads the JSON rules, not this file.

## Desired behavior

After the last substantive change, verify the requested outcome through the actual scenario and relevant logs. For a text deliverable, read and assess its meaning, completeness and usability directly.

## Executable contract

1. Derive the deciding property and a distinguishing scenario from requirements, independently of the implementation or test under review.
2. Exercise the real mechanism, inspect the observable result and relevant logs, and compare with the prediction. Tests/build/lint establish only their measured properties. An executed real integration scenario inside a test can provide direct evidence of that scenario.
3. Repair demonstrated violations and refresh affected observations. Report the conditions and exact unverified properties; finish when the outcome and required checks are satisfied.

Use the relevant native runtime/browser/desktop tool and read its applicable skill. For UI, inspect a real render after the last meaningful change; screenshots, geometry and interaction establish different properties. See rules70,71,73,75,77 and `docs/standing-rules/04-bindings.md`.

## Anti-patterns

A green suite or reviewer verdict as proof of the whole product; an unseen screenshot; tests or external verification scripts becoming a substitute for implementation; broadening checks without a concrete uncertainty; inventing a runtime for a purely textual outcome.
