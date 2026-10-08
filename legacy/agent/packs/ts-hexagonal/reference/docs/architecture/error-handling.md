# Error handling

## Two kinds of failure

| Kind | Examples | Mechanism |
|---|---|---|
| **Expected**: part of the business | Invalid input, missing referenced thing, rule violated | Return a `Result` |
| **Unexpected**: a bug or broken infrastructure | Database down, corrupt stored data, programming error | `throw` |

```ts
type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
```

## Why `Result` for expected failures

- TypeScript has no checked exceptions, so a throwing function looks like it always succeeds. A `Result` puts the failure in the signature.
- The caller cannot reach `.value` without checking `.ok` first; TypeScript narrows the type.
- A `Result` crosses tRPC and MCP as plain data, so the UI receives the actual message ("Item title is required") instead of a generic error.

## Rules

- **`parse` methods** on value objects and commands return `Result`. They never return `undefined` and never throw for bad input.
- **Handlers** return `Result` when the feature has an expected failure; otherwise they return the value directly.
- **Pass failures through unchanged** when the types line up (`if (!x.ok) return x;`) rather than re-wrapping them.
- **Mappers throw** when stored data fails to parse, because that means corrupt data.
- **Out adapters let infrastructure errors propagate.** They are handled once, at the top of the app (the framework's error handling or the entry file), not by every caller.
- **In adapters return a `Result` failure as data.** They do not convert expected failures into transport errors.
- Error values are currently message strings. Use the `E` type parameter for structured errors when callers need to branch on the kind of failure.
