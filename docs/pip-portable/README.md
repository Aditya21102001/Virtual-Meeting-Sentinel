# Picture-in-picture that survives navigation

A portable implementation of "pop the video out, then go and do something else, and it keeps
playing". Framework-agnostic core, Angular adapter, integration notes for React and vanilla.

Extracted from Virtual Meeting Sentinel. For the project-specific history — the three failed
attempts, the browser harness, the bundle-size regression — see [`../PICTURE_IN_PICTURE.md`](../PICTURE_IN_PICTURE.md).

| File | What it is |
| --- | --- |
| `pip-host.ts` | The whole feature. No imports, no framework. |
| `player-host.service.ts` | Angular adapter — same decisions, exposed as signals. |

---

## 1. The constraint everything follows from

From the [Picture-in-Picture specification](https://w3c.github.io/picture-in-picture/):

> When a video element is **removed from its node document**, the user agent must run the
> **exit Picture-in-Picture** algorithm.

`Node.appendChild()` on a node that already has a parent performs a *remove* and then an *insert*.
So moving a `<video>` **anywhere** — into another container in the same document, synchronously, in
the same tick — ends the session.

**Therefore: the element must be neither moved nor destroyed.** It cannot be owned by any component
the router can tear down.

That single sentence rules out the two implementations everybody writes first:

| Approach | Why it fails |
| --- | --- |
| On destroy, re-parent the `<video>` into a hidden `<div>` on `document.body` | The move *is* the removal. Window freezes on its last frame. |
| Same, but fix the teardown ordering so the hand-off runs before the stream is destroyed | The ordering bug may be real, but it was never the cause. Fixing it changes nothing. |

There is no ordering, timing, or lifecycle trick that rescues a DOM move. Don't spend a day looking
for one.

## 2. The architecture

Mount the player **once, outside the router outlet**, in an absolutely-positioned layer. Pages render
an empty slot and say where it is. The layer is drawn over the slot.

```
RootComponent  (never destroyed by routing)
│
├── <main><router-outlet>              ← pages come and go here
│        └── LibraryPage
│             └── <div class="player-slot">   ← empty; only reserves space
│
└── <div class="player-layer">         ← OUTSIDE the outlet
         └── <VideoPlayer>             ← the one <video>, never moved
```

Navigation then changes **only CSS**. The element stays connected throughout, so the session is never
interrupted — and neither is ordinary playback.

### Four invariants

1. **Never move the element.** No `appendChild`, no portal that re-parents, no `key` change that
   remounts.
2. **Never unmount it while a session is live.** Park it with CSS instead.
3. **Park, don't hide.** `display: none` and detaching both end the session. Use size + opacity.
4. **Position in document coordinates**, not viewport ones — then scrolling needs no listener.

### Park vs. stop

Navigating away is a decision, not a reflex:

| State on navigate | Behaviour |
| --- | --- |
| In picture-in-picture | Park the layer off-screen, keep playing, watch for the window closing. |
| Not in picture-in-picture | Clear the item, unmount the player, playback stops. |

Keeping a video playing after navigation is correct **only** when the viewer explicitly asked for it
by popping it out. Otherwise audio continues from a page nobody can see, which reads as a bug however
well-intentioned.

### Getting back

`leavepictureinpicture` fires for **both** of the floating window's buttons and carries nothing to
say which. The observable difference is playback state:

- **returning to the tab** leaves the video `playing`
- **closing the window** `pause`s it

```ts
const returningToTab = !video.paused;
```

A heuristic, written to fail harmlessly. Read as "closed", the player stops and the viewer stays put.
Dragging somebody who just finished onto a video page is worse than making somebody who wanted to
return click once.

Because the element was never unmounted, arriving back at the page re-anchors **the same element**,
still playing mid-frame. Passing `t=<seconds>` is belt-and-braces; the player is already there.

---

## 3. The required CSS

Not optional, and the `.parked` rule is the whole feature. Getting it wrong is silent — playback looks
fine right up until someone navigates.

```css
/*
  Absolute, in DOCUMENT coordinates — not fixed in viewport ones. Scrolling then moves the layer
  with the page for free; only a resize or layout change needs re-measuring.
*/
.player-layer {
  position: absolute;
  z-index: 5;
}

/*
  Parked: off-screen but STILL RENDERED and still in the document.
  NOT display:none, and never detached — either ends the session this exists to preserve.
  The visible window is drawn by the OS and does not need the source element to be on screen.
*/
.player-layer.parked {
  position: fixed;
  top: auto;
  bottom: 0;
  left: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
}
```

The slot must have **the same box the player draws itself into**. If they disagree the layer sits
slightly off:

```css
.player-slot {
  aspect-ratio: 16 / 9;   /* identical to the player's own */
  width: 100%;
  background: #000;
  border-radius: 12px;
}
```

---

## 4. Integration — Angular

**Step 1.** Copy `pip-host.ts` and `player-host.service.ts`, then provide the config:

```ts
// app.config.ts
import { PLAYER_HOST_CONFIG } from './services/player-host.service';

providers: [
  {
    provide: PLAYER_HOST_CONFIG,
    useFactory: () => {
      const router = inject(Router);
      return {
        navigateToItem: (item: VideoCard, at: number) =>
          void router.navigate(['/recordings'], { queryParams: { v: item.video.id, t: at } }),
        idOf: (item: VideoCard) => item.video.id,
      };
    },
  },
],
```

**Step 2.** Render the layer in the root component, **outside** the `<router-outlet>`:

```html
@defer (when playerHost.item()) {
  @if (playerHost.item(); as item) {
    <div
      class="player-layer"
      [class.parked]="!playerHost.box()"
      [style.top.px]="playerHost.box()?.top"
      [style.left.px]="playerHost.box()?.left"
      [style.width.px]="playerHost.box()?.width"
      [style.height.px]="playerHost.box()?.height"
    >
      <app-video-player #hostedPlayer [card]="item" [autoplay]="true"
                        [startAt]="playerHost.startAt()"></app-video-player>
    </div>
  }
}
```

Publish the instance so pages can still reach it, and expose the console snapshot:

```ts
private readonly hostedPlayer = viewChild<VideoPlayerComponent>('hostedPlayer');

private readonly publishPlayer = effect(() =>
  this.playerHost.registerPlayer(this.hostedPlayer() ?? null));

private readonly exposeSnapshot = effect(() => {
  (window as unknown as Record<string, unknown>)['__pipState'] = () => this.playerHost.snapshot();
});
```

**Step 3.** The page renders a slot instead of the player:

```html
<div class="player-slot" #playerSlot></div>
```

```ts
private readonly playerSlot = viewChild<ElementRef<HTMLElement>>('playerSlot');

// Both are needed: the slot only exists once something is selected (same @if).
private readonly attachPlayer = effect(() => {
  const item = this.selected();
  const slot = this.playerSlot();
  if (item && slot) {
    untracked(() => this.playerHost.attach(item, this.startAt(), slot.nativeElement));
  }
});

ngOnDestroy(): void {
  this.playerHost.detach();   // parks or stops — the service decides
}
```

**Step 4.** Anything that used `viewChild` for the player reads the service instead. Call sites are
unchanged:

```ts
private readonly player = this.playerHost.player;   // was viewChild<VideoPlayerComponent>('player')
```

### Angular pitfalls, all of which shipped as bugs

**`@defer` is load-bearing, not an optimisation.** The player pulls in hls.js. Referenced normally
from the root component it lands in the **main bundle**: first load went 138 kB → 279 kB for every
visitor, including those who never open a video. Inside a `@defer` block the compiler keeps it in its
own chunk, fetched when something is first selected. Back to 141 kB.

**`untracked` around `attach()` is mandatory.** It reads and writes signals; without it the effect
depends on its own output and re-runs forever.

**Publishing the instance is easy to forget.** Declare the `viewChild`, skip `registerPlayer`, and
every feature that talks to the player breaks while playback itself looks perfect. Worth a test.

## 5. Integration — React

Same architecture; `PipHost` is the same object. Hold it in a ref, mirror its state:

```tsx
function usePipHost(navigate) {
  const [state, setState] = useState({ item: null, startAt: null, box: null });
  const hostRef = useRef();
  if (!hostRef.current) {
    hostRef.current = new PipHost({
      onChange: setState,
      onReturn: (item, at) => navigate(`/recordings?v=${item.id}&t=${at}`),
      idOf: (item) => item.id,
      ownsElement: (el) => !!el.closest('.player-layer'),
    });
  }
  useEffect(() => () => hostRef.current.destroy(), []);
  return [state, hostRef.current];
}
```

Two React-specific traps:

- **Render the layer above the router**, in the component that owns `<Routes>`. A portal is fine only
  if its container is created once and never re-created — a portal that re-parents on re-render is
  exactly the failure this design avoids.
- **Never let `key` change** on the player or the `<video>`. React remounts on a new key, which
  destroys the element and the session with it.

The page calls `attach` in an effect on `[item, slotEl]`, and `detach` in that effect's cleanup.

## 6. Integration — vanilla

```ts
const host = new PipHost({
  onChange: ({ item, box }) => {
    layer.classList.toggle('parked', !box);
    if (box) Object.assign(layer.style, {
      top: `${box.top}px`, left: `${box.left}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    if (!item) player.stop();
  },
  onReturn: (item, at) => { location.href = `/recordings?v=${item.id}&t=${at}`; },
});
```

Create `layer` once, append it to `document.body`, and never touch its parent again.

---

## 7. Verifying it

Most of this **cannot** be checked by reading the code, and the original shipped broken twice because
nobody ran it. Two mechanical points about testing it:

**`page.goto()` is not navigation.** It is a full reload: it destroys the JS context, never invokes
the router, and never runs your teardown. It will report failures that do not exist and pass things
that are broken. Click the nav links, as a user does.

**Real picture-in-picture cannot be driven headless** — `requestPictureInPicture()` needs a user
gesture. Override `document.pictureInPictureElement` instead; it is the exact input this code reads,
so every branch is still exercised.

What automation can confirm:

- [ ] the layer sits exactly over its slot (`dx:0, dy:0, dw:0`)
- [ ] the box is a real size, so the player is not drawn over nothing
- [ ] navigating away **without** picture-in-picture unmounts the player and stops playback
- [ ] navigating away **while** in picture-in-picture keeps the element in the DOM and parks the layer
- [ ] the return-watch arms itself
- [ ] `document.querySelectorAll('video').length` never exceeds 1

What needs one manual pass, every time — the OS composites the window, so no harness sees it:

- [ ] pop out a recording, navigate away → it keeps playing
- [ ] click **back to tab** → lands on the recording, still playing
- [ ] click **close** → playback stops, you stay where you are

> The paused-vs-playing heuristic in step 2 is the least certain thing here. It holds in current
> Chrome; it is not specified behaviour, and no automated test can cover it.

## 8. Diagnostics

Silent unless switched on:

```js
localStorage.pip_debug = '1'
```

Then the console traces `attach`, `detach {keepPlaying}`, `watching`, and `window closed
{paused, decision}`. `__pipState()` is always available.

**The failure signature to look for:** `detach {keepPlaying: false}` while a floating window is open.
It means the browser is not reporting the session, so the player is about to be unmounted and the
window is about to die.

If that happens and a session really is open, check `ownsElement`. The default in the Angular adapter
requires the element to be inside `.player-layer`; a different class name makes it return false for
your own player, which produces exactly this signature.
