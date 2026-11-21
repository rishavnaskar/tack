# Tack UI

Vite + React 19 + TypeScript. Plain CSS with tokens, `motion` for animation, fonts bundled from fontsource.

```
npm install
npm run dev:mock     # no server needed: in-browser mock of every /api route
npm run dev          # proxies /api to 127.0.0.1:4400 (override with TACK_API=http://host:port)
npm run build        # typecheck + build to ui/dist (relative asset paths)
npm run typecheck
```

Mock switches (add to any URL while `dev:mock` runs): `?mock=fresh` starts from an empty store, `?mock=slow` adds 2.5 s latency, `?mock=error` makes every GET fail. Mock state lives in `localStorage` under `tack.mock.v1`.

## Layout

```
src/ui/        design system (tokens.css, base.css, components); import from './ui'
src/api/       types.ts (copy of coach/src/types.ts), client.ts, query.ts, hooks.ts, events.ts, mock/
src/screens/   Start, Market, Gap (+ gap/ layout and constellation), Placeholder
src/lib/       small formatters (hostOf, ago, pct, countBy, median)
```

Breakpoints: the rail is full at 1100px and up, numbers only from 720px, and a bottom bar under 720px. Screen layouts use container queries on `content` (the main column), so they also adapt when the trace panel takes room.

## Data

- `api.*` in `src/api/client.ts`: one function per route in docs/SPEC.md.
- Hooks in `src/api/hooks.ts`: `useAppState`, `usePostings`, `useGap`, `usePlan`, `usePortfolio`, `useInterviews`, `useApplications`, `useInsights`, `useProgress`, `useBrief`. Each returns `{ data, error, status, loading, fetching, refetch }`. `useGap` and `usePlan` return `null` for a 404 (not built yet).
- `actions.*` in the same file wraps every write and keeps the cache right (`setQueryData` / `invalidate`). Long calls go through `tracked(label, fn)`, which opens the trace rail on wide screens and pulses the activity dot.
- `useQuery(key, fetcher, { enabled })`, `useMutation(fn, { onSuccess, invalidates })`, `invalidate(...keys)` (a key ending in `*` is a prefix), `setQueryData`, `clearCache` live in `src/api/query.ts`.
- `useTrace()` in `src/api/events.ts` gives `{ events, connected, pending, pendingLabel, hot, open, unseen }`; `trace.setOpen`, `trace.clear`, `trace.begin(label)`.

## Components

All from `src/ui`. Colors only through tokens: `--ink`, `--ink-soft`, `--paper`, `--cream`, `--olive`, `--accent`, `--accent-hi`, `--line`, `--line-soft`, `--line-faint`, `--mute`, `--faint`. Text helpers: `.t-label` (mono uppercase micro-label), `.t-micro`, `.t-num` (mono figures), `.t-mute`, `.t-faint`, `.t-accent`.

| Component | Props |
|---|---|
| `AppShell` | `nav: NavItem[]` (`{index, label, short?, path, meta?, attention?}`), `status?`, `overlay?`, `asideOpen?`, `children` |
| `PageHeader` | `index`, `section`, `title` (string, revealed word by word), `purpose?`, `actions?`, `children?` (extra row) |
| `RevealWords` | `text`, `delay?`, `step?`, `className?` |
| `Wordmark` | `reveal?`, `className?` |
| `Card` | `tone?: glass \| solid \| outline \| cream`, `pad?: none \| sm \| md \| lg`, `label?`, `index?`, `aside?`, `interactive?`, `settle?: boolean \| delaySeconds`, div props |
| `Button` | `variant?: primary \| ghost \| quiet`, `size?: sm \| md \| lg`, `icon?` (right), `iconLeft?`, `loading?`, `to?` (router link), `href?`, `target?`, `download?`, `block?`, button props |
| `Chip` | `tone?: default \| accent \| olive \| cream \| mute`, `size?: sm \| md`, `level?` (glyph), `selected?` + `onClick?` (filter toggle), `count?`, `mono?` |
| `LevelGlyph` | `level: strong \| partial \| missing`, `size?`; `levelLabel[level]` for text |
| `Meter` | `value`, `max?` (100), `marker?` (target tick), `tone?: paper \| accent \| olive \| cream`, `variant?: bar \| segments`, `segments?`, `size?: xs \| sm \| md`, `label?`, `valueLabel?`, `showValue?` |
| `Bar` | `label`, `value`, `max`, `figure?`, `highlight?`, `delay?` (one distribution row) |
| `Dial` | `value` (0-100), `size?`, `label?`, `caption?`, `ticks?` |
| `Stat` | `label`, `value`, `unit?`, `note?`, `delta?`, `size?: sm \| md \| lg`, `index?` |
| `QuoteBlock` | `quote`, `source` (e.g. "Résumé" or a company), `detail?`, `tone?: paper \| accent \| olive`, `size?: sm \| md \| lg`, `onClick?` |
| `Drawer` | `open`, `onClose`, `title`, `eyebrow?`, `actions?`, `footer?`, `width?` (px); bottom sheet under 720px; Escape and focus trap built in |
| `Modal` | `open`, `onClose`, `title`, `eyebrow?`, `footer?`, `width?` |
| `Tabs` | `items: {id, label, count?, icon?, disabled?}[]`, `value`, `onChange`, `variant?: pill \| line`, `size?: sm \| md`, `aria-label` |
| `EmptyState` | `title`, `body?`, `action?`, `eyebrow?`, `compact?` |
| `ErrorState` | `title?`, `message?` (mono), `onRetry?`, `action?`, `compact?` |
| `Skeleton` | `width?`, `height?`, `radius?`, `lines?` |
| `BlueprintLoader` | `label?`, `detail?` (latest trace line), `stages?: string[]`, `stage?`, `height?`; use for long runs |
| `ToastProvider` / `useToast()` | `toast({ title, body?, tone?: default \| success \| error, action?: {label, onClick}, duration? })` |
| `TraceRail` | `events`, `open`, `onOpenChange`, `active?`, `activeLabel?`, `connected?`, `unseen?`, `onClear?` (already mounted in `App.tsx`) |
| `TextField` / `TextArea` | `label?`, `hint?`, `error?`, `large?` (TextField), input props |
| `Toggle` | `checked`, `onChange`, `label`, `hint?`, `disabled?` |
| `Stepper` | `value`, `onChange`, `min?`, `max?`, `step?`, `label?`, `unit?`, `hint?` |
| `DropZone` | `onFile`, `title`, `hint?`, `accept?`, `disabled?`, `busy?` |
| `Icon` | `name` (see `icons.tsx`), `size?` |
| `useNarrow()` | true under 720px |
| motion helpers | `ease`, `easeInOut`, `settle`, `stagger(i)` |

## Next screens

`/plan`, `/portfolio`, `/interview`, `/tracker` and `/progress` render `Placeholder` in `src/App.tsx`. Replace each route element with the new screen. Start every screen with `PageHeader` (indexes 03 to 07) and cover loading (`Skeleton`), empty (`EmptyState`) and error (`ErrorState`) states. The mock already answers every route those screens need, with fixtures for Avery Quinn: a 12-week plan, 3 portfolio projects, 2 interview sessions, 24 applications with a reply pattern, tracker insights, progress and the daily brief.
