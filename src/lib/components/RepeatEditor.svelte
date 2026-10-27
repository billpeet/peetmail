<script lang="ts">
  // The event editor's Repeat row: a preset (from the start date) or a custom pattern, and how
  // it ends. Edits the shared Recurrence model, which the backend turns into Graph's
  // patternedRecurrence or Google's RRULE.
  import { untrack } from "svelte";
  import {
    WEEKDAYS,
    dayName,
    describeRecurrence,
    matchPreset,
    nthOfMonth,
    ordinalName,
    presets,
    recurrenceProblem,
    weekdayOf,
    type PresetId,
    type Recurrence,
    type RecurrenceEnd,
    type Weekday,
  } from "$lib/recurrence";

  let { value = $bindable(), start }: { value: Recurrence | null; start: string } = $props();

  type Mode = "none" | PresetId | "custom";
  // Set up once from what the event had; after that the select drives it.
  let mode = $state<Mode>(untrack(() => (value ? matchPreset(value, start) : "none")));
  const choices = $derived(start ? presets(start) : []);
  const never: RecurrenceEnd = { type: "never" };

  const pad = (n: number) => String(n).padStart(2, "0");
  const dateParts = (iso: string) => iso.split("-").map(Number);
  function plusMonths(iso: string, n: number) {
    const [y, m, d] = dateParts(iso);
    const t = new Date(y, m - 1 + n, d);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }

  function choose(next: Mode) {
    mode = next;
    if (next === "none") value = null;
    else if (next === "custom") value = value ? { ...value, start } : { ...presets(start).find((p) => p.id === "weekly")!.rule };
    else value = { ...choices.find((p) => p.id === next)!.rule, end: value?.end ?? never };
  }

  // A preset follows the start date (weekly on its weekday...); a custom pattern keeps its shape.
  let lastStart = untrack(() => start);
  $effect(() => {
    const s = start;
    if (!s || s === lastStart) return;
    lastStart = s;
    if (!value) return;
    if (mode === "custom") {
      value = { ...value, start: s };
      return;
    }
    const list = presets(s);
    // "The fourth Tuesday" may not exist from the new date: fall back to "the last".
    const p = list.find((x) => x.id === mode) ?? (mode === "monthlyNth" ? list.find((x) => x.id === "monthlyLast") : undefined);
    if (p) {
      mode = p.id;
      value = { ...p.rule, end: value.end };
    } else {
      mode = "custom";
      value = { ...value, start: s };
    }
  });

  // ----- custom -----
  const UNITS = [
    ["daily", "day"],
    ["weekly", "week"],
    ["monthly", "month"],
    ["yearly", "year"],
  ] as const;

  function setUnit(freq: Recurrence["freq"]) {
    if (!value) return;
    const [, m, d] = dateParts(start);
    const keep = { interval: value.interval, end: value.end, start };
    const blank = { days: [] as Weekday[], ordinal: null, dayOfMonth: null, month: null };
    if (freq === "daily") value = { freq, ...blank, ...keep };
    else if (freq === "weekly") value = { freq, ...blank, days: [weekdayOf(start)], ...keep };
    else if (freq === "monthly") value = { freq, ...blank, dayOfMonth: d, ...keep };
    else value = { freq, ...blank, dayOfMonth: d, month: m, ...keep };
  }

  function toggleDay(day: Weekday) {
    if (!value) return;
    const days = value.days.includes(day) ? value.days.filter((x) => x !== day) : [...value.days, day];
    value = { ...value, days: WEEKDAYS.filter((x) => days.includes(x)) };
  }

  /** Monthly/yearly: on the date, or on the nth (or last) weekday. */
  const monthlyMode = $derived(!value || value.ordinal === null ? "day" : value.ordinal === -1 ? "last" : "nth");
  const nth = $derived(start ? nthOfMonth(start) : { ordinal: 1, isLast: false });
  function setMonthlyMode(m: string) {
    if (!value) return;
    const [, month, d] = dateParts(start);
    const yearly = value.freq === "yearly" ? { month } : { month: null };
    if (m === "day") value = { ...value, ordinal: null, days: [], dayOfMonth: d, ...yearly };
    else value = { ...value, ordinal: m === "last" ? -1 : Math.min(nth.ordinal, 4), days: [weekdayOf(start)], dayOfMonth: null, ...yearly };
  }

  // ----- ends -----
  function setEnd(type: string) {
    if (!value) return;
    const end: RecurrenceEnd = type === "until" ? { type, date: plusMonths(start, 3) } : type === "count" ? { type, count: 10 } : never;
    value = { ...value, end };
  }

  const problem = $derived(value ? recurrenceProblem(value) : null);
  const monthName = $derived(start ? new Date(dateParts(start)[0], dateParts(start)[1] - 1, 1).toLocaleDateString(undefined, { month: "long" }) : "");
  const field = "rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent";
</script>

<div data-testid="repeat-editor" class="space-y-2">
  <select data-testid="editor-repeat-select" value={mode} onchange={(e) => choose(e.currentTarget.value as Mode)} class={field}>
    <option value="none">Doesn't repeat</option>
    {#each choices as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
    <option value="custom">Custom…</option>
  </select>

  {#if value}
    <div class="space-y-2 rounded-md border border-ink-800 bg-ink-950/40 p-3">
      {#if mode === "custom"}
        <div class="flex flex-wrap items-center gap-2">
          <span>Every</span>
          <input
            data-testid="repeat-interval"
            type="number"
            min="1"
            max="99"
            value={value.interval}
            oninput={(e) => value && (value = { ...value, interval: Number(e.currentTarget.value) })}
            class={[field, "w-16"]}
          />
          <select data-testid="repeat-unit" value={value.freq} onchange={(e) => setUnit(e.currentTarget.value as Recurrence["freq"])} class={field}>
            {#each UNITS as [freq, unit] (freq)}<option value={freq}>{value.interval === 1 ? unit : `${unit}s`}</option>{/each}
          </select>
          {#if value.freq === "monthly" || value.freq === "yearly"}
            <select data-testid="repeat-monthly-mode" value={monthlyMode} onchange={(e) => setMonthlyMode(e.currentTarget.value)} class={field}>
              <option value="day">on day {dateParts(start)[2]}{value.freq === "yearly" ? ` of ${monthName}` : ""}</option>
              {#if nth.ordinal <= 4}<option value="nth">on the {ordinalName(nth.ordinal)} {dayName(weekdayOf(start))}{value.freq === "yearly" ? ` of ${monthName}` : ""}</option>{/if}
              {#if nth.isLast}<option value="last">on the last {dayName(weekdayOf(start))}{value.freq === "yearly" ? ` of ${monthName}` : ""}</option>{/if}
            </select>
          {/if}
        </div>
        {#if value.freq === "weekly"}
          <div class="flex items-center gap-1" role="group" aria-label="Repeat on">
            {#each WEEKDAYS as d (d)}
              <button
                type="button"
                data-testid="repeat-day"
                data-day={d}
                aria-pressed={value.days.includes(d)}
                title={dayName(d)}
                onclick={() => toggleDay(d)}
                class={["size-8 rounded-full text-xs font-medium", value.days.includes(d) ? "bg-accent text-chrome" : "border border-ink-700 text-ink-300 hover:text-ink-100"]}
              >
                {dayName(d).slice(0, 2)}
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <span>Ends</span>
        <select data-testid="repeat-end" value={value.end.type} onchange={(e) => setEnd(e.currentTarget.value)} class={field}>
          <option value="never">Never</option>
          <option value="until">On a date</option>
          <option value="count">After a number of times</option>
        </select>
        {#if value.end.type === "until"}
          <input
            data-testid="repeat-until"
            type="date"
            min={start}
            value={value.end.date}
            onchange={(e) => value && (value = { ...value, end: { type: "until", date: e.currentTarget.value } })}
            class={field}
          />
        {:else if value.end.type === "count"}
          <input
            data-testid="repeat-count"
            type="number"
            min="1"
            max="999"
            value={value.end.count}
            oninput={(e) => value && (value = { ...value, end: { type: "count", count: Number(e.currentTarget.value) } })}
            class={[field, "w-20"]}
          />
          <span>times</span>
        {/if}
      </div>

      {#if problem}
        <p data-testid="repeat-problem" class="text-xs text-red-300">{problem}</p>
      {:else}
        <p data-testid="repeat-summary" class="text-xs text-ink-300">{describeRecurrence(value)}</p>
      {/if}
    </div>
  {/if}
</div>
