# Picture-in-picture across navigation

How a recording keeps playing in its floating window while the viewer goes and does something else,
why the obvious implementation cannot work, and what it cost to find that out.

---

## The requirement

Pop a recording out into a floating window, then navigate to the board or the ballot. The video
should keep playing. Closing the window by returning it to the tab should take the viewer back to
the recording, at the point it reached.

## The constraint everything else follows from

From the [Picture-in-Picture specification](https://w3c.github.io/picture-in-picture/):

> When a video element is **removed from its node document**, the user agent must run the
> **exit Picture-in-Picture** algorithm.

`Node.appendChild()` on a node that already has a parent performs a *remove* and then an *insert*.
So moving a `<video>` element anywhere — even to another container in the same document, even
synchronously — ends the session.

The element must therefore be **neither moved nor destroyed**. In an Angular application that rules
out the element being owned by anything the router can tear down.

---

## Three attempts, and why the first two failed

Worth recording, because both looked correct and both shipped.

### Attempt 1 — move the element to a persistent host

`PipKeepAliveService` re-parented the `<video>` into a hidden `<div>` on `document.body` as the page
was destroyed:

```ts
this.ensureHost().appendChild(video);   // ← ends the session, by specification
```

**Symptom:** the floating window froze on its last frame.

**Why it failed:** the constraint above. There is no ordering, timing or lifecycle trick that makes
a DOM move survive picture-in-picture, because the move *is* the removal.

### Attempt 2 — fix the destroy ordering

The player's setup effect registered `onCleanup(() => this.teardown())`, and `teardown()` calls
`hls.destroy()`. The theory was that Angular ran that cleanup before `ngOnDestroy`, so the stream
died before the hand-off. The hand-off was moved to a `DestroyRef` callback registered ahead of the
effect, guaranteeing it ran first.

**Symptom:** unchanged.

**Why it failed:** the ordering problem was probably real, but it was never the cause. Fixing it
changed nothing because attempt 1's approach could not work regardless. This is what diagnosing
without evidence looks like: a plausible mechanism, a real fix, and no effect.

### Attempt 3 — never move the element

The player is mounted **once, outside the router outlet**, and positioned over a slot the page
reserves. Navigation changes only CSS.

---

## The architecture

```
AppComponent  (never destroyed by routing)
│
├── <main><router-outlet>          ← pages come and go here
│        └── VideosComponent
│             └── <div class="player-slot">    ← empty; only reserves space
│
└── <div class="player-layer">     ← OUTSIDE the outlet
         └── <app-video-player>    ← the one <video>, never moved
```

`PlayerHostService` holds the state both sides share: which recording, where to draw it, and the
live player instance.

### Positioning

The layer is positioned **absolutely, in document coordinates**:

```ts
const rect = this.anchor.getBoundingClientRect();
this.box.set({
  top: rect.top + window.scrollY,
  left: rect.left + window.scrollX,
  width: rect.width,
  height: rect.height,
});
```

Document coordinates rather than viewport ones, so scrolling moves the layer with the page and needs
no scroll listener. A `ResizeObserver` on the slot catches layout changes — a wrapping description, a
font loading, the window resizing.

### Parking

Navigating away while in picture-in-picture sets `box` to null, which is styled, not unmounted:

```css
.player-layer.parked {
  position: fixed;
  bottom: 0; left: 0;
  width: 1px; height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
}
```

Deliberately **not** `display: none` and never detached — either would end the session this exists to
preserve. The visible window is drawn by the operating system and does not need the source element
to be on screen.

### The decision on navigate

```ts
detach(): void {
  this.releaseAnchor();

  if (this.inPictureInPicture()) {
    this.box.set(null);      // park: CSS only, nothing moves
    this.watchForReturn();
    return;
  }

  this.card.set(null);       // ordinary navigation stops playback, as it always has
  this.startAt.set(null);
  this.box.set(null);
}
```

Keeping a video playing after navigation is only correct when the viewer explicitly asked for it.
Otherwise audio would continue from a page nobody can see.

### Returning to the tab

`leavepictureinpicture` fires for **both** of the window's buttons and carries nothing to say which.
The observable difference is playback state: returning to the tab leaves the video playing, closing
pauses it.

```ts
const returningToTab = !video.paused;
if (returningToTab && videoId) {
  void this.router.navigate(['/recordings'], { queryParams: { v: videoId, t: at } });
}
```

A heuristic, written to fail harmlessly: if it reads "closed", the player stops and the viewer stays
where they are. Dragging somebody who just finished onto a video page is worse than making somebody
who wanted to return click once.

Because the element was never unmounted, arriving back at the page re-anchors the *same* element,
still playing mid-frame. The `t` parameter is belt-and-braces — the player is already at that point.

---

## Files changed

| File | Change |
| --- | --- |
| `services/player-host.service.ts` | **New.** Owns the card, the box, the player instance; decides park-vs-stop; watches for the window closing. |
| `app.component.ts` | Renders the layer outside the outlet, inside `@defer`; publishes the player instance; parked/positioned CSS. |
| `pages/videos.component.ts` | Renders `.player-slot` instead of the player; attaches on selection; `detach()` on destroy; reads the player from the service. |
| `services/auth.service.ts` | Unrelated to PiP — see the note on `hasRealAccount` below. |

### Two things that are easy to get wrong

**1. `@defer` is load-bearing, not an optimisation.**

```html
@defer (when playerHost.card()) { … }
```

The player pulls in hls.js. Referenced normally from `AppComponent` it lands in the **main bundle**,
and first load went from 138 kB to 279 kB for every visitor — including those who never open a
recording. Used only inside a `@defer` block the compiler keeps it in its own chunk, fetched when a
recording is first selected. Back to **141 kB**.

**2. The page no longer owns the player, but still needs it.**

`VideosComponent` uses the instance for the transcript, for seeking from a segment or a comment, and
for the playhead on the comment composer. It read those off a local `viewChild`; the instance now
travels through the service:

```ts
private readonly player = this.playerHost.player;   // was viewChild<VideoPlayerComponent>('player')
```

`AppComponent` publishes it with an effect, because the player comes and goes with the `@defer` and
the `@if`. Declaring the `viewChild` and forgetting to publish it silently breaks all three features
— it did, and only a test caught it.

---

## Testing

None of the first two attempts was ever run in a browser. That is the root cause of all of this, so
the fix ships with a harness that drives real Chrome: `pip_browser_test.mjs`, 13 checks.

```bash
node scratchpad/serve.mjs frontend/dist/agm-sentinel-frontend/browser 4200 &
APP_URL=http://127.0.0.1:4200 node scratchpad/pip_browser_test.mjs
```

Port 4200 matters: it is the only localhost origin the backend's CORS allows.

Verified by observation:

- the layer sits **exactly** over its slot — `dx:0, dy:0, dw:0`
- the box is a real size, so the player is not drawn over nothing
- navigating away **without** picture-in-picture unmounts the player and stops playback
- navigating away **while** in picture-in-picture keeps the element in the DOM and parks the layer
- the return-watch arms itself

### Two harness bugs worth knowing about

**`page.goto()` is not navigation.** It is a full page reload: it destroys the JS context, never
invokes Angular's router, and so never runs `ngOnDestroy`. The first runs reported failures that did
not exist. Only clicking nav links, as a user does, exercises the real path.

**Real picture-in-picture cannot be tested headless.** `requestPictureInPicture()` needs a user
gesture. The harness overrides `document.pictureInPictureElement` instead — the exact input
`PlayerHostService` reads, so every branch of the application's logic is exercised.

### What that leaves unverified

Chrome's own compositing of the floating window, and the paused-vs-playing heuristic for "back to
tab". Both need one manual pass:

1. pop out a recording, navigate away — it should keep playing;
2. click "back to tab" — it should land on the recording, still playing.

## Diagnostics

Silent unless switched on:

```js
localStorage.agm_pip_debug = '1'
```

Then the console traces `attach`, `detach {keepPlaying}`, `watching`, and `window closed
{paused, decision}`. `__pipState()` is always available and returns a snapshot: whether the browser
reports a session, whether the player is mounted, whether the layer is parked, and the measured box.

`detach {keepPlaying: false}` while a floating window is open is the failure signature — it means the
browser is not reporting the session, so the player is about to be unmounted.

---

## Note on `hasRealAccount`

Committed alongside this work but unrelated to it. The navigation offered attendees **Lounge** and
**Voting** links that answered 403, because the menu gated them on the feature flag alone while the
server also requires a verified account. `AuthService.hasRealAccount()` mirrors the server's rule so
the interface stops advertising what it cannot deliver. It is not a security control — the route
rules are — it only keeps the menu honest.
