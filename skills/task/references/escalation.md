# Depth, routing and progress

Read when selecting depth or when the task changes materially. Respect an explicit depth;
`light` means trivial. Increase depth when the actual work requires it; do not downgrade to
avoid an applicable gate.

## Depth

- `trivial`: bounded mechanical change with no material design decision. MAIN may implement
  it directly. Use SINGLE.
- `standard`: interacting behavior, an implementation choice or a shared boundary requiring
  a coherent plan. Use SINGLE.
- `complex`: genuinely dependent deliverables or consequential recovery. Use SINGLE for an
  indivisible result or UNITS for independently deliverable outcomes and their integration.

Depth follows real uncertainty and consequences, not keyword matches, file count or mood.
A public API, extension hook, trust/authorization boundary or material cross-layer data flow
requires at least standard treatment. Use complex when dependencies or recovery require it.
An existing requirement or explicit task depth is not waived because work looks easy.

## Gates and ownership

All full-mode depths receive plan review, implementation review and product acceptance.
Escalation changes planning/execution granularity; it does not change repair permissions or
remove a gate. Plan-only and review-only use their distinct branches in modes.md.

MAIN routes actual background role calls. No separate Native driver or scheduler is assumed.
Planner writes the initial PLAN; critic repairs PLAN/CRYSTAL §2; worker or MAIN implements;
implementation-critic repairs its explicit product scope; product-validator never repairs.
Source §1/§3 and user authority remain unchanged by escalation.

## Repeated failures

There is no automatic repair-round cap. Continue while a new observation, meaningful repair
or discriminating probe makes progress. Do not rerun an unchanged failed action for reassurance.
A repeated failure of the same requirement sends work back to its plan/mechanism cause or
missing environment prerequisite. Never reduce the required outcome to obtain a positive verdict.

Malformed/crashed role calls have one fresh retry with the same artifact payload, as defined
in verdict-grammar.md. That transport/format recovery rule is separate from product repairs.
Stop when the full outcome and required gates pass, the user stops the work, or a concrete
unresolved prerequisite is reported honestly. A blocked gate is not success.
