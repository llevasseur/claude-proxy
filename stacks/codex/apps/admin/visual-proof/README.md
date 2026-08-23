# Overview verification evidence

## Runtime exercised

- Fixture upstream: `http://127.0.0.1:62948`
- Actual codex-proxy: `http://127.0.0.1:62955`
- Actual API and SSE server: `http://127.0.0.1:62963`
- Vite client: `http://127.0.0.1:5174` (`5173` was already occupied)

The empty SSE snapshot reported zero requests. A proxied `gpt-5-mini` response
then published an SSE update with 1,250 input tokens, 240 output tokens, and
`0.0007475` USD. A second proxied response using `fixture-unknown` published an
aggregate with 1,571 input tokens, 327 output tokens, and explicit
`aggregate-incomplete` unavailable cost.

## Visual gate

The required in-app browser backend was queried immediately after Vite started.
Its backend list was empty, so no screenshots or interaction claims were
recorded. Desktop, narrow/mobile, light/dark, drawer, keyboard-focus, and
disconnect/reconnect visual proof remain required before commit or merge.

## Static verification

The applicable pinned style files match claude-proxy commit
`cc25696504e724bd78824e639e97a0a1d846abea` byte for byte. The production CSS
contains the copied custom properties plus the Bike drawer, status, and
unavailable-cost selectors. The aggregate repository verifier passed after the
runtime fixture directory was ignored.
