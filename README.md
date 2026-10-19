# FocusFlow - Student Productivity Companion

A local-first Chrome extension (Manifest V3) that combines a task manager, a Pomodoro focus timer,
quick notes and a daily progress dashboard in one popup.

## Problem statement
Students often juggle separate apps for tasks, study timers and notes. That friction makes it harder
to keep a steady routine. FocusFlow puts all three in one lightweight popup, with no account and no server.

## Features
- **Tasks:** add (title 1-200 characters, optional due date), edit, complete/reopen, delete with confirmation, filters, counts.
- **Focus timer:** focus / short break / long break, start, pause, resume, reset, mode switching. Next session never auto-starts.
- **Notes:** create, edit, delete with confirmation, debounced autosave with visible save status.
- **Progress:** today's completed tasks, focus sessions and minutes; task totals and completion percentage; all-time focus totals.
- **Settings:** durations, sessions before a long break, light/dark theme, "reset all data" with typed confirmation.

## Screenshots
_Placeholders. Screenshots will be added after the extension has been run and tested._

| Tasks | Focus | Notes | Progress |
|---|---|---|---|
| _(pending)_ | _(pending)_ | _(pending)_ | _(pending)_ |

## Technology stack
HTML5, CSS3, vanilla JavaScript (ES modules), Chrome Extensions Manifest V3 (`chrome.storage.local`,
`chrome.alarms`, service worker). No frameworks, no bundler, no runtime dependencies.

## Architecture overview
Two JavaScript contexts share `chrome.storage.local`: the **popup** (UI, created on click, destroyed on close)
and the **service worker** (wakes for alarms, can be suspended at any time). Nothing important is kept in memory.

```mermaid
flowchart TB
    subgraph Presentation
        HTML[popup.html + style.css]
        SCRIPT[script.js coordinator]
        UIF[ui-focus.js]
        UIN[ui-notes.js]
        UIP[ui-progress.js]
        UIS[ui-settings.js]
    end
    subgraph Application
        TASKS[tasks.js]
        NOTES[notes.js]
        TIMER[timer.js]
        STATS[statistics.js]
        SETT[settings.js]
    end
    STORAGE[storage.js]
    SW[service-worker.js]
    subgraph Platform
        CS[(chrome.storage.local)]
        AL[chrome.alarms]
    end
    HTML --> SCRIPT --> UIF & UIN & UIP & UIS
    SCRIPT --> TASKS
    UIF --> TIMER
    UIN --> NOTES
    UIP --> STATS
    UIS --> SETT
    TIMER --> STATS
    TIMER --> SETT
    STATS --> TASKS
    TASKS & NOTES & SETT & TIMER & STATS --> STORAGE --> CS
    TIMER --> AL
    AL -- alarm --> SW --> TIMER
```

### Data flow
```mermaid
flowchart TD
    A[User action] --> B{Validate}
    B -- invalid --> E[Show message]
    B -- valid --> C[Module updates data]
    C --> D[storage.js writes one key]
    D -- failed --> E
    D -- ok --> F[UI re-renders]
    subgraph Timer
      S[Start] --> T[endTime = now + duration; save; create alarm]
      T --> X[Alarm fires OR popup sees now >= endTime]
      X --> L[Take timer lock]
      L --> R{Still running and expired?}
      R -- no --> N[Ignore]
      R -- yes --> Q[Record session by id once]
      Q --> I[State becomes idle in the next mode]
    end
```

### Timer states
```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> running: start
    running --> paused: pause
    paused --> running: resume
    running --> idle: expires (session counted once if focus)
    running --> idle: reset (nothing counted)
    paused --> idle: reset (nothing counted)
```

## File structure
```
FocusFlow/
├── manifest.json  popup.html  style.css  script.js  service-worker.js
├── README.md  LICENSE  .gitignore
├── js/  config.js storage.js tasks.js settings.js statistics.js timer.js notes.js
│        ui-focus.js ui-notes.js ui-progress.js ui-settings.js
├── assets/icons/  icon16.png icon32.png icon48.png icon128.png
└── tools/make-icons.js   (dev-only icon generator, not used at runtime)
```

## Storage design
All timestamps are epoch milliseconds. Calendar days are local `"YYYY-MM-DD"` strings.

| Key | Shape | Written by |
|---|---|---|
| `tasks` | `[{id, title, completed, createdAt, dueDate, completedAt}]` | `tasks.js` (popup) |
| `notes` | `[{id, title, content, createdAt, updatedAt}]` | `notes.js` (popup) |
| `settings` | `{schemaVersion, focusMinutes, shortBreakMinutes, longBreakMinutes, sessionsBeforeLongBreak, theme}` | `settings.js` (popup) |
| `timerState` | `{status, mode, sessionId, durationSeconds, endTime, remainingSeconds, cycleFocusCount, lastCompletedSessionId}` | `timer.js` (popup + service worker, under a lock) |
| `dailyStats` | `{"YYYY-MM-DD": {sessions: [{id, durationSeconds, completedAt, dev}]}}` | `statistics.js`, only via the timer lock |

Statistics are derived from tasks and the session list, not from separate counters.
Invalid stored values are repaired per key at startup (a warning is shown, the original is logged to the console).

## Local installation
1. Download or clone this folder.
2. Generate icons once: `node tools/make-icons.js` (or provide your own PNGs).
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the `FocusFlow` folder.
4. Pin the extension and open it from the toolbar.

## Testing
Follow the manual test plan (install, tasks, timer, notes, statistics, settings, security). For fast timer tests set
`DEV_MODE = true` in `js/config.js`, reload the extension, and set it back to `false` afterwards.
Test results are recorded by you; none are claimed here.

## Permissions
| Permission | Why |
|---|---|
| `storage` | Save tasks, notes, timer state, statistics and settings on this device. |
| `alarms` | Wake the background worker when a timer session ends. |

No host permissions, no `tabs`, no `history`, no content scripts.

## Privacy and data handling
- All data stays on your device in `chrome.storage.local`.
- FocusFlow makes no network requests, has no analytics, ads or tracking, and loads no remote code.
- Data is deleted by Settings, then "Reset all data" (type DELETE to confirm), or by removing the extension.
- Chrome's local storage is not encrypted by the extension. Do not store secrets in notes.

## Known limitations
- `chrome.storage.local` has no transactions. Double-counting is prevented with a Web Locks mutex plus unique session IDs, which is a design that must be tested, not a proof.
- A final autosave when the popup closes is best-effort. Chrome may destroy the popup before an asynchronous write completes.
- Alarms can fire late, and Chrome may enforce a minimum alarm delay. The timer's time always comes from `endTime`, so lateness does not corrupt the time.
- Selected tab and task filter are not remembered between popup opens.
- Only the active timer state is stored. Old daily statistics are not pruned.
- The completion signal is a toolbar badge ("DONE"). There are no desktop notifications or sounds.

## Future roadmap (not implemented)
Browser notifications, keyboard shortcuts, JSON export/import, weekly charts, new-tab dashboard.

## Credits and third-party licenses
All code is original. No third-party libraries, fonts or icons are used. The icon generator writes simple placeholder PNGs.

Licensed under the MIT License (see `LICENSE`).
## Translation (English to Hindi)
Right-click selected English text and choose "Translate to Hindi". An optional floating Translate
button (Settings, off by default) shows near selected text.

**Third-party disclosure:** selected text is sent over HTTPS to MyMemory (api.mymemory.translated.net).
FocusFlow does not store or log selected or translated text. Free quota (per MyMemory's published limits):
5,000 characters/day anonymously, 500 bytes per request. Review MyMemory's Terms of Service before distributing.

**Permissions added:** `contextMenus` (right-click item); host access to api.mymemory.translated.net only
(the request); optional access to http/https sites (only if you enable the floating button; it reads your text
selection and nothing else). `activeTab` and `scripting` show the panel on the page you used the menu on.

**Limitations:** English only, 500-byte limit, restricted pages (chrome://, Web Store) cannot be used,
translation quality depends on the provider, daily quota applies.
## Productivity Coach (Progress tab)
A local, rule-based coach. It reads your tasks and completed focus sessions and shows a daily summary,
up to three suggestions (each with the reason it appeared), and a 7-day view once at least 7 days of data exist.
- Runs entirely on your device: no network requests, no API key, no new permissions, nothing stored.
- Suggestions are informational only. The coach never changes tasks, timers or settings.
- Not a validated measurement of productivity, and focus sessions are not linked to individual tasks.
- Weekly task counts come from tasks still in your list (deleted or reopened tasks are not counted).
- "Today" is the local calendar day. If your timezone changes, past items are re-read in the new timezone.
- Tests: `node tools/test-coach.js`
## Daily Planner (Planner tab)
Builds a proposed schedule for a time window you choose (start time, available time, longest work session,
break length, default task length). Pending tasks are ranked: overdue first, then due today, due within 3 days,
due later, and no due date; within each group by priority, then due date, then age. Each task is placed whole
(split into parts with breaks if longer than the longest session). Tasks that do not fit are listed with a reason.
- Local and deterministic: no network, no API key, no new permissions.
- Review only: it never edits, completes or reorders tasks, and nothing is saved.
- Tasks have no stored duration. Each uses the default length unless you enter an in-memory estimate (5-480 min),
  which is forgotten when the popup closes. Invalid estimates fall back to the default.
- It is a simple rule-based suggestion, not an optimal schedule. It does not know about meetings or dependencies.
- The plan must end by midnight on the same day.
- Tests: `node tools/test-planner.js`
## Smart Focus Recommendations (Focus tab, "Next up")
Suggests one pending task, up to two alternatives, and a focus session and break, with the reasons shown.
- Uses the same ranking as the Planner (overdue, due today, due within 3 days, due later, no due date; then
  priority, due date, age), so the two never disagree.
- Reads your real timer state: it says so if a session or break is in progress, and names the break your timer will
  offer next (short or long, from your settings).
- A note about your recorded sessions appears only with at least 5 sessions on 3 days.
- Read-only and local: no network, no new permissions, nothing stored. It does not start the timer or change tasks.
- Tasks have no stored duration, so it never claims a task fits in one session. No productivity or health claims.
- In development mode (`DEV_MODE`) the minutes shown come from Settings, not the short test durations.
- Tests: `node tools/test-recommendations.js`