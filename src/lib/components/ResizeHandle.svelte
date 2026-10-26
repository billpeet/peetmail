<script lang="ts">
  // Drag handle for resizable panels (ARIA "window splitter"). Sits over one edge of its
  // positioned parent. Drag to resize, arrow keys when focused (Shift = bigger steps),
  // double-click or Home to reset. `onchange` fires once the drag ends (save it there);
  // `onpreview` fires while dragging so the panel can follow the pointer.
  let {
    edge,
    value,
    min,
    max,
    defaultValue,
    label,
    testid,
    onpreview,
    onchange,
  }: {
    /** Which edge of the panel the handle sits on. Dragging away from the panel grows it. */
    edge: "left" | "right";
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    testid: string;
    onpreview: (w: number | null) => void;
    onchange: (w: number) => void;
  } = $props();

  let dragging = $state(false);
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(w, max)));

  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startValue = value;
    const sign = edge === "left" ? -1 : 1;
    let latest: number | null = null;
    dragging = true;
    const move = (ev: PointerEvent) => {
      latest = clamp(startValue + sign * (ev.clientX - startX));
      onpreview(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      dragging = false;
      onpreview(null);
      if (latest !== null) onchange(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function onkeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    const grow = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft";
    if (e.key === grow) onchange(clamp(value + step));
    else if (e.key === shrink) onchange(clamp(value - step));
    else if (e.key === "Home") onchange(clamp(defaultValue));
    else return;
    e.preventDefault();
    e.stopPropagation(); // keep arrows away from list navigation
  }
</script>

<!-- A focusable separator is the ARIA "window splitter" pattern, which the linter
     doesn't recognise as interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  data-testid={testid}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  tabindex="0"
  title="Drag to resize · double-click to reset"
  onpointerdown={startDrag}
  ondblclick={() => onchange(clamp(defaultValue))}
  {onkeydown}
  class={[
    "absolute inset-y-0 z-10 w-2 cursor-col-resize outline-none",
    edge === "left" ? "-left-1" : "-right-1",
    "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-accent/60 focus-visible:after:bg-accent",
    dragging && "after:bg-accent",
  ]}
></div>
