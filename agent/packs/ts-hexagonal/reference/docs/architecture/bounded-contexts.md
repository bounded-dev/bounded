# Bounded contexts

A **bounded context** is a part of the business with its own language and model. Within one context a word means one thing; another context may use the same word differently.

## One package per context

```
contexts/<context>/        package @<scope>/<context>
  src/domain/
  src/application/
  src/adapters/
```

- Layers are **folders**, not separate packages. `architecture.test.ts` enforces the dependency rule between them.
- Consumers import one layer at a time through the package's export paths (`@<scope>/<context>/application`).
- Split a context into more packages only for a concrete reason, such as keeping a heavy adapter dependency out of an app that doesn't need it.

## Areas inside a context

A context holds several **areas**: groups of concepts and features that the business thinks of together. Areas are folders inside each layer, not separate packages. Concepts and features that change together belong in the same context, even if they are different areas.

## Rules between contexts

1. **A context never imports another context's domain, application or adapters** from its domain or application layers.
2. **Refer to another context's things by ID only.** Store the ID; never hold the other context's objects.
3. **To ask another context something,** the consumer declares its **own out port** in its own language (for example `ItemLookup.exists(id)`). An out adapter in the consumer, and **only** there, implements it by calling the provider's public **in ports** (`@<scope>/<provider>/application`) and translating the result. That adapter is the anti-corruption layer, and `architecture.test.ts` allows exactly this import and no other between contexts.
4. **To react to another context,** the provider publishes a domain event through an out port, and the consumer subscribes with an in adapter. Neither calls the other directly, and the reaction happens shortly after rather than in the same step.
5. **Apps are the only place contexts meet.** The composition root wires one context's handlers into another context's adapters and combines the contexts' routers into one API.
6. **Never read another context's tables.** Each context owns its Postgres schema.

In DDD terms, the context that provides is **upstream** and the one that consumes is **downstream**.

## Shared kernel

Code shared by several contexts must be tiny, generic and stable (for example `Result` or brand helpers). Business concepts are never shared: a shared business entity quietly couples every context together. Until a second context needs it, shared code stays inside the context (`domain/shared/`).

## Separate repositories

Keep all contexts in this monorepo. Moving a context to its own repository only makes sense when separate teams release it on separate schedules. The package boundary already provides the isolation.
